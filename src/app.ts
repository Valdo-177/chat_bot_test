import { join } from 'path';
import { createBot, createProvider, createFlow, addKeyword, utils } from '@builderbot/bot';
import { PostgreSQLAdapter as Database } from '@builderbot/database-postgres';
import { BaileysProvider as Provider } from '@builderbot/provider-baileys';
import 'dotenv/config.js';

const PORT = process.env.PORT ?? 3008;

const getSpecialties = async () => {
    try {
        const response = await fetch("https://api.finsalu.com/api/get-specialtys");
        if (!response.ok) {
            throw new Error('Failed to fetch specialties from API');
        }
        const data = await response.json();
        const specialties = data.data
            .map((specialty: any) => specialty.name)
            .filter((name: string) => name !== 'No Aplica');
        return specialties;
    } catch (error) {
        console.error("Error fetching specialties:", error);
        return ["No se pudieron cargar las especialidades en este momento."];
    }
};

const flowConfirmacion = addKeyword(['si', 'sí', 'correcto']).addAnswer(
    '¡Perfecto! Tu cita ha sido agendada con éxito. Te esperamos.',
    null,
    async (ctx, { state, endFlow }) => {
        const appointmentData = state.get('appointmentData');
        console.log('Datos de la cita para guardar:', appointmentData);
        // ... (código para guardar en PostgreSQL)
        console.log('Cita guardada en la base de datos');
        return endFlow();
    }
);


const flowAgenda = addKeyword(['2', 'agendar', 'cita']).addAnswer(
    '¡Perfecto! Para agendar tu cita, necesito la siguiente información: \n\n*Nombre completo* \n*Fecha (día/mes/año)* \n*Hora de la cita* \n*Especialidad* \n*Teléfono*',
    { capture: true },
    async (ctx, { gotoFlow }) => {
        // El usuario dará todos los datos en un solo mensaje o en varios, lo cual será manejado por el siguiente flujo.
        // Redirigimos al flujo que usa la IA para procesar la información.
        return gotoFlow(flowIA);
    }
);

const flowSummary = addKeyword('__any__').addAnswer(
    'Generando resumen...',
    null,
    async (ctx, { state, flowDynamic, gotoFlow }) => {
        const appointmentData = state.get('appointmentData');
        if (!appointmentData || !appointmentData.nombreCompleto) {
            await flowDynamic("Lo siento, hubo un problema al recopilar tus datos. Por favor, intentemos de nuevo. Escribe 'agendar'");
            return;
        }

        const summary = `
        *Resumen de la Cita:*
        *Nombre:* ${appointmentData.nombreCompleto}
        *Fecha:* ${appointmentData.fecha}
        *Hora:* ${appointmentData.hora}
        *Especialidad:* ${appointmentData.especialidad}
        `;
        await flowDynamic(summary);
        await flowDynamic("¿Es correcta la información para agendar la cita? (Sí/No)");
    },
    [
        flowConfirmacion,
        addKeyword(['no']).addAnswer('Ok, volvamos a empezar. ¿Qué te gustaría hacer hoy?', null, null, [flowAgenda]),
    ]
);

const flowIA = addKeyword('__any__').addAnswer(
    'Estoy procesando tu solicitud...',
    null,
    async (ctx, { state, flowDynamic, provider, gotoFlow }) => {
        const currentState = state.get('appointmentData') || {};
        const userPrompt = ctx.body;
        console.log('Mensaje del usuario:', userPrompt);

        const prompt = `
        Eres un extractor de datos para citas médicas.
        Debes devolver un JSON con los campos: "nombreCompleto", "fecha", "hora", "especialidad", "telefono".
        - La fecha debe estar en formato YYYY-MM-DD (asume año actual si no se especifica).
        - La hora debe estar en formato HH:MM en 12h.
        - Acepta entradas como "mañana", "próximo lunes", "20 de agosto", "4 de la tarde".
        - Si un dato no está presente, su valor será null.
        - NO devuelvas texto adicional, solo JSON.

        Ejemplo:
        Usuario: "Mi nombre es Juan Pérez, quiero la cita para el 20 de agosto a las 4 pm con cardiología, mi número es 3001234567"
        Respuesta:
        {
          "nombreCompleto": "Juan Pérez",
          "fecha": "2025-08-20",
          "hora": "16:00",
          "especialidad": "Cardiología",
          "telefono": "3001234567"
        }

        Datos actuales: ${JSON.stringify(currentState)}
        Mensaje del usuario: "${userPrompt}"
        `;
        console.log('Prompt enviado a la IA:', prompt);

        try {
            await provider.sendPresenceUpdate('composing', ctx.key.remoteJid);
            const response = await fetch("http://localhost:11434/api/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "phi3:mini",
                    prompt: prompt,
                    stream: false
                }),
            });
            await provider.sendPresenceUpdate('paused', ctx.key.remoteJid);

            if (!response.ok) {
                await flowDynamic("Lo siento, no puedo procesar tu solicitud en este momento. Inténtalo más tarde.");
                console.error("Error en la respuesta de la API de Ollama:", response.status, response.statusText);
                return;
            }

            const data = await response.json();
            console.log("Respuesta completa de la API de Ollama:", data);
            
            // Extraer el JSON de la respuesta. El modelo puede devolverlo dentro de un bloque de código.
            const aiResponse = data.response;
            const jsonStartIndex = aiResponse.indexOf('{');
            const jsonEndIndex = aiResponse.lastIndexOf('}');
            let jsonString = '';

            if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
                jsonString = aiResponse.substring(jsonStartIndex, jsonEndIndex + 1);
            } else {
                console.error("No se pudo encontrar un JSON válido en la respuesta de la IA.");
                await flowDynamic("Hubo un problema procesando tu respuesta. La IA no devolvió el formato esperado.");
                return;
            }

            console.log("JSON extraído de la respuesta:", jsonString);

            let extractedData;
            try {
                extractedData = JSON.parse(jsonString);
            } catch (e) {
                console.error("Error al analizar el JSON extraído:", e);
                await flowDynamic("Hubo un problema procesando tu respuesta. Por favor, intenta de nuevo.");
                return;
            }

            console.log("Datos de la cita extraídos:", extractedData);
            // Actualizamos el estado con los datos extraídos
            await state.update({ appointmentData: { ...currentState, ...extractedData } });
            
            // Redirigimos al flujo de resumen
            return gotoFlow(flowSummary);

        } catch (e) {
            console.error("Error en la llamada a la API de Ollama:", e);
            await flowDynamic("Lo siento, no puedo procesar tu solicitud en este momento. Inténtalo más tarde.");
            return;
        }
    }
);

const flowSpecialties = addKeyword(['1']).addAnswer(
    'Buscando especialidades...',
    null,
    async (ctx, { flowDynamic }) => {
        const specialtiesList = await getSpecialties();
        await flowDynamic(`Las especialidades disponibles son: \n\n* ${specialtiesList.join('\n* ')}`);
        await flowDynamic('Para agendar una cita, escribe "2" o "agendar".');
    }
);

const welcomeFlow = addKeyword<Provider, Database>(
    ['Hola', 'Hello', 'Buenas'], { sensitive: false }
).addAnswer(
    '👋 ¡Hola! Soy la IA de Salu, tu asistente virtual para agendar citas médicas.',
    {
        delay: 800,
    },
    async (ctx, { flowDynamic }) => {
        await flowDynamic('¿Qué te gustaría hacer hoy? \n\n*1.* Ver especialidades \n*2.* Agendar una cita');
    },
    [flowSpecialties, flowAgenda]
);


const main = async () => {
    const adapterFlow = createFlow([
        welcomeFlow,
        flowSpecialties,
        flowAgenda,
        flowSummary,
        flowConfirmacion,
        flowIA // Agregamos el nuevo flujo de IA a la lista de flujos
    ]);
    const adapterProvider = createProvider(Provider);
    const adapterDB = new Database({
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        database: process.env.POSTGRES_DB_NAME,
        password: process.env.POSTGRES_DB_PASSWORD,
        port: +process.env.POSTGRES_DB_PORT
    });

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpServer(+PORT);
};

main();
