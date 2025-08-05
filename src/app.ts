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
        const specialties = data.data.map((specialty: any) => specialty.name);
        return specialties.join(', ');
    } catch (error) {
        console.error("Error fetching specialties:", error);
        return "No se pudieron cargar las especialidades en este momento.";
    }
};

const flowSpecialties = addKeyword(['1']).addAnswer(
    'Buscando especialidades...',
    null,
    async (ctx, { flowDynamic }) => {
        const specialtiesList = await getSpecialties();
        await flowDynamic(`Las especialidades disponibles son: ${specialtiesList}`);
        await flowDynamic('Para agendar una cita, escribe "2" o "agendar".');
    }
);

const flowAgenda = addKeyword(['2', 'agendar', 'cita']).addAnswer(
    '¡Perfecto! Para agendar tu cita, necesito la siguiente información. ¿Por cuál dato quieres empezar?',
    { capture: true },
    async (ctx, { flowDynamic, state, provider }) => {
        const userPrompt = ctx.body;
        const currentState = state.get('appointmentData') || {};

        const prompt = `Eres un asistente de citas médicas. Tu objetivo es recolectar del usuario los siguientes datos en formato JSON:
        - nombreCompleto
        - fecha
        - hora
        - especialidad
        - telefono

        Si falta algún dato, haz la pregunta correspondiente. Si ya tienes todos los datos, devuelve un JSON con la información completa.
        Datos actuales: ${JSON.stringify(currentState)}
        Mensaje del usuario: "${userPrompt}"`;

        await provider.sendPresenceUpdate('composing', ctx.key.remoteJid);

        const response = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama3",
                prompt: prompt,
                stream: false
            }),
        });

        await provider.sendPresenceUpdate('paused', ctx.key.remoteJid);

        if (!response.ok) {
            await flowDynamic("Lo siento, no puedo procesar tu solicitud en este momento. Inténtalo más tarde.");
            return;
        }

        const data = await response.json();
        const aiResponse = data.response;

        try {
            const jsonResponse = JSON.parse(aiResponse);
            if (jsonResponse.nombreCompleto && jsonResponse.fecha && jsonResponse.hora && jsonResponse.especialidad && jsonResponse.telefono) {
                await state.update({ appointmentData: jsonResponse });
                const summary = `
                *Resumen de la Cita:*
                *Nombre:* ${jsonResponse.nombreCompleto}
                *Fecha:* ${jsonResponse.fecha}
                *Hora:* ${jsonResponse.hora}
                *Especialidad:* ${jsonResponse.especialidad}
                *Teléfono:* ${jsonResponse.telefono}
                `;
                await flowDynamic(summary);
                await flowDynamic("¿Es correcta la información para agendar la cita? (Sí/No)");
            } else {
                await flowDynamic(aiResponse);
            }
        } catch (e) {
            await flowDynamic(aiResponse);
        }
    }
);

const welcomeFlow = addKeyword<Provider, Database>(
    'Hola', { sensitive: true }
).addAnswer(
    '👋 ¡Hola! Soy la IA de Salu, tu asistente virtual para agendar citas médicas.',
    {
        delay: 800,
        idle: 300000
    },
    async (ctx, { flowDynamic, endFlow }) => {
        if (ctx.idle) {
            return endFlow('Se ha cerrado la sesión por inactividad. Para empezar de nuevo, envía un mensaje.');
        }

        await flowDynamic('¿Qué te gustaría hacer hoy? \n\n*1.* Ver especialidades \n*2.* Agendar una cita');
    },
    [flowSpecialties, flowAgenda]
);


const main = async () => {
    const adapterFlow = createFlow([welcomeFlow, flowSpecialties, flowAgenda]);
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