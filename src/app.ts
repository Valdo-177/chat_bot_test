import { join } from 'path';
import { createBot, createProvider, createFlow, addKeyword, utils } from '@builderbot/bot';
import { PostgreSQLAdapter as Database } from '@builderbot/database-postgres';
import { BaileysProvider as Provider } from '@builderbot/provider-baileys';
import 'dotenv/config.js';

const PORT = process.env.PORT ?? 3008;

let specialtyMapping: { [key: number]: string } = {};

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
        
        specialtyMapping = {};
        const formattedSpecialties = specialties.map((name: string, index: number) => {
            specialtyMapping[index + 1] = name;
            return `${index + 1}. ${name}`;
        });

        return formattedSpecialties;
    } catch (error) {
        console.error("Error fetching specialties:", error);
        return ["No se pudieron cargar las especialidades en este momento."];
    }
};

const flowConfirmacion = addKeyword(['si', 'sí', 'correcto']).addAnswer(
    'Agendando cita medica',
    null,
    async (ctx, { state, endFlow, flowDynamic }) => {
        const appointmentData = state.get('appointmentData');
        console.log('Datos de la cita para guardar:', appointmentData);

        try {
            const response = await fetch("http://localhost:5000/api/quote", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(appointmentData)
            });

            if (!response.ok) {
                console.error("Error al agendar la cita en la API externa:", response.status, response.statusText);
                await flowDynamic("Lo siento, hubo un problema al agendar tu cita. Por favor, intenta de nuevo más tarde.");
                return endFlow();
            }

            const result = await response.json();
            console.log('Respuesta de la API de agendamiento:', result);

            await flowDynamic('¡Perfecto! Tu cita ha sido agendada con éxito. Te esperamos.');

        } catch (error) {
            console.error("Error en la petición POST para agendar la cita:", error);
            await flowDynamic("Lo siento, no pude comunicarme con el servicio de agendamiento. Por favor, intenta de nuevo más tarde.");
        }

        return endFlow();
    }
);

// Flujo para la captura de los datos del usuario (nombre, fecha, hora)
const flowDatosCita = addKeyword('__datosCita__')
    .addAnswer(
        'Por favor, escribe tu nombre completo.',
        { capture: true },
        async (ctx, { state }) => {
            await state.update({ nombreCompleto: ctx.body });
        }
    )
    .addAnswer(
        'Ahora, por favor, dime la fecha para tu cita (ej. "20 de agosto" o "mañana").',
        { capture: true },
        async (ctx, { state }) => {
            await state.update({ fecha: ctx.body });
        }
    )
    .addAnswer(
        'Finalmente, dime la hora de tu cita (ej. "a las 4 pm" o "a las 16:00").',
        { capture: true },
        async (ctx, { state, gotoFlow }) => {
            await state.update({ hora: ctx.body });
            // Una vez que tenemos los 3 datos, redirigimos al flujo de IA
            return gotoFlow(flowIA);
        }
    );

const flowSummary = addKeyword('__any__').addAnswer(
    'Generando resumen...',
    null,
    async (ctx, { state, flowDynamic, gotoFlow }) => {
        const appointmentData = state.get('appointmentData');
        if (!appointmentData || !appointmentData.nombreCompleto) {
            await flowDynamic("Lo siento, hubo un problema al recopilar tus datos. Por favor, intentemos de nuevo. Escribe 'Hola'");
            return;
        }

        console.log('Datos de la cita para mostrar:', appointmentData);
        const summary = `
        *Resumen de la Cita:*
        Nombre: ${appointmentData.nombreCompleto}
        Fecha: ${appointmentData.fecha}
        Hora: ${appointmentData.hora}
        Especialidad: ${appointmentData.especialidad}
        `;
        console.log('Resumen de la cita:', summary);
        await flowDynamic(summary);
        await flowDynamic("¿Es correcta la información para agendar la cita? (Sí/No)");
    },
    [
        flowConfirmacion,
        addKeyword(['no']).addAnswer('Ok, volvamos a empezar. ¿Qué te gustaría hacer hoy?', null, null, [flowDatosCita]),
    ]
);

const flowIA = addKeyword('__any__').addAnswer(
    'Estoy procesando tu solicitud...',
    null,
    async (ctx, { state, flowDynamic, provider, gotoFlow }) => {
        const currentState = state.get('appointmentData') || {};
        const userPrompt = `${currentState.nombreCompleto}, ${currentState.fecha}, ${currentState.hora}`;
        console.log('Mensaje del usuario (procesado):', userPrompt);

        const prompt = `
        Eres un extractor de datos para citas médicas.
        Debes devolver un JSON con los campos: "nombreCompleto", "fecha", "hora", "especialidad", "telefono".
        - El "nombreCompleto" debe ser extraído de la parte del mensaje que parezca un nombre.
        - La fecha debe estar en formato YYYY-MM-DD (asume año actual si no se especifica).
        - La hora debe estar en formato HH:MM en 12h.
        - Acepta entradas como "mañana", "próximo lunes", "20 de agosto", "4 de la tarde".
        - Si un dato no está presente, su valor será null.
        - NO devuelvas texto adicional, solo JSON.
        - Datos de especialidad, nombre, fecha y hora se proporcionan por separado. No intentes extraerlos del mensaje del usuario si ya están en el estado.

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
                const cleanedJsonString = jsonString.replace(/\/\/.*(?=,?\s*["}\]])/g, '');
                extractedData = JSON.parse(cleanedJsonString);
            } catch (e) {
                console.error("Error al analizar el JSON extraído:", e);
                await flowDynamic("Hubo un problema procesando tu respuesta. Por favor, intenta de nuevo.");
                return;
            }

            console.log("Datos de la cita extraídos:", extractedData);
            await state.update({ appointmentData: { ...currentState, ...extractedData } });

            return gotoFlow(flowSummary);

        } catch (e) {
            console.error("Error en la llamada a la API de Ollama:", e);
            await flowDynamic("Lo siento, no puedo procesar tu solicitud en este momento. Inténtalo más tarde.");
            return;
        }
    }
);


const flowSpecialties = addKeyword(['1'])
.addAnswer(
    'Buscando especialidades...',
    null,
    async (ctx, { flowDynamic }) => {
        const specialtiesList = await getSpecialties();
        await flowDynamic(`Estas son las especialidades disponibles: \n\n* ${specialtiesList.join('\n* ')}`);
        await flowDynamic('Para agendar una cita, por favor escribe el número de la especialidad de tu interés.');
    }
)
.addAnswer(
    'Escribe el número de la especialidad:',
    { capture: true },
    async (ctx, { state, gotoFlow, flowDynamic }) => {
        const selectedNumber = parseInt(ctx.body);
        if (specialtyMapping[selectedNumber]) {
            const selectedSpecialty = specialtyMapping[selectedNumber];
            await state.update({ appointmentData: { especialidad: selectedSpecialty } });
            return gotoFlow(flowDatosCita);
        } else {
            await flowDynamic('Número de especialidad no válido. Por favor, intenta de nuevo.');
            return gotoFlow(flowSpecialties);
        }
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
        await flowDynamic('¿Qué te gustaría hacer hoy? \n\n*1.* Agendar una cita');
    },
    [flowSpecialties]
);

const main = async () => {
    const adapterFlow = createFlow([
        welcomeFlow,
        flowSpecialties,
        flowDatosCita,
        flowSummary,
        flowConfirmacion,
        flowIA
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



// import { join } from 'path';
// import { createBot, createProvider, createFlow, addKeyword, utils } from '@builderbot/bot';
// import { PostgreSQLAdapter as Database } from '@builderbot/database-postgres';
// import { BaileysProvider as Provider } from '@builderbot/provider-baileys';
// import 'dotenv/config.js';

// const PORT = process.env.PORT ?? 3008;

// const getSpecialties = async () => {
//     try {
//         const response = await fetch("https://api.finsalu.com/api/get-specialtys");
//         if (!response.ok) {
//             throw new Error('Failed to fetch specialties from API');
//         }
//         const data = await response.json();
//         const specialties = data.data
//             .map((specialty: any) => specialty.name)
//             .filter((name: string) => name !== 'No Aplica');
//         return specialties;
//     } catch (error) {
//         console.error("Error fetching specialties:", error);
//         return ["No se pudieron cargar las especialidades en este momento."];
//     }
// };

// const flowConfirmacion = addKeyword(['si', 'sí', 'correcto']).addAnswer(
//     'Agendando cita medica',
//     null,
//     async (ctx, { state, endFlow, flowDynamic }) => {
//         const appointmentData = state.get('appointmentData');
//         console.log('Datos de la cita para guardar:', appointmentData);

//         try {
//             const response = await fetch("http://localhost:5000/api/quote", {
//                 method: 'POST',
//                 headers: {
//                     'Content-Type': 'application/json'
//                 },
//                 body: JSON.stringify(appointmentData)
//             });

//             if (!response.ok) {
//                 console.error("Error al agendar la cita en la API externa:", response.status, response.statusText);
//                 await flowDynamic("Lo siento, hubo un problema al agendar tu cita. Por favor, intenta de nuevo más tarde.");
//                 return endFlow();
//             }

//             const result = await response.json();
//             console.log('Respuesta de la API de agendamiento:', result);

//             await flowDynamic('¡Perfecto! Tu cita ha sido agendada con éxito. Te esperamos.');

//         } catch (error) {
//             console.error("Error en la petición POST para agendar la cita:", error);
//             await flowDynamic("Lo siento, no pude comunicarme con el servicio de agendamiento. Por favor, intenta de nuevo más tarde.");
//         }

//         return endFlow();
//     }
// );

// const flowAgenda = addKeyword(['2', 'agendar', 'cita']).addAnswer(
//     '¡Perfecto! Para agendar tu cita, necesito la siguiente información: \n\n*Nombre completo* \n*Fecha (día/mes/año)* \n*Hora de la cita* \n*Especialidad* \n*Teléfono*',
//     { capture: true },
//     async (ctx, { gotoFlow }) => {
//         // El usuario dará todos los datos en un solo mensaje o en varios, lo cual será manejado por el siguiente flujo.
//         // Redirigimos al flujo que usa la IA para procesar la información.
//         return gotoFlow(flowIA);
//     }
// );

// const flowSummary = addKeyword('__any__').addAnswer(
//     'Generando resumen...',
//     null,
//     async (ctx, { state, flowDynamic, gotoFlow }) => {
//         const appointmentData = state.get('appointmentData');
//         if (!appointmentData || !appointmentData.nombreCompleto) {
//             await flowDynamic("Lo siento, hubo un problema al recopilar tus datos. Por favor, intentemos de nuevo. Escribe 'agendar'");
//             return;
//         }

//         console.log('Datos de la cita para mostrar:', appointmentData);
//         // localhost:5000/api/quote

//         const summary = `
//         *Resumen de la Cita:*
//         Nombre: ${appointmentData.nombreCompleto}
//         Fecha: ${appointmentData.fecha}
//         Hora: ${appointmentData.hora}
//         Especialidad: ${appointmentData.especialidad}
//         `;
//         console.log('Resumen de la cita:', summary);
//         await flowDynamic(summary);
//         await flowDynamic("¿Es correcta la información para agendar la cita? (Sí/No)");
//     },
//     [
//         flowConfirmacion,
//         addKeyword(['no']).addAnswer('Ok, volvamos a empezar. ¿Qué te gustaría hacer hoy?', null, null, [flowAgenda]),
//     ]
// );

// const flowIA = addKeyword('__any__').addAnswer(
//     'Estoy procesando tu solicitud...',
//     null,
//     async (ctx, { state, flowDynamic, provider, gotoFlow }) => {
//         const currentState = state.get('appointmentData') || {};
//         const userPrompt = ctx.body;
//         console.log('Mensaje del usuario:', userPrompt);

//         const prompt = `
//         Eres un extractor de datos para citas médicas.
//         Debes devolver un JSON con los campos: "nombreCompleto", "fecha", "hora", "especialidad", "telefono".
//         - El "nombreCompleto" debe ser extraído de la parte del mensaje que parezca un nombre.
//         - La fecha debe estar en formato YYYY-MM-DD (asume año actual si no se especifica).
//         - La hora debe estar en formato HH:MM en 12h.
//         - Acepta entradas como "mañana", "próximo lunes", "20 de agosto", "4 de la tarde".
//         - Si un dato no está presente, su valor será null.
//         - NO devuelvas texto adicional, solo JSON.

//         Ejemplo:
//         Usuario: "Mi nombre es Juan Pérez, quiero la cita para el 20 de agosto a las 4 pm con cardiología, mi número es 3001234567"
//         Respuesta:
//         {
//           "nombreCompleto": "Juan Pérez",
//           "fecha": "2025-08-20",
//           "hora": "16:00",
//           "especialidad": "Cardiología",
//           "telefono": "3001234567"
//         }

//         Datos actuales: ${JSON.stringify(currentState)}
//         Mensaje del usuario: "${userPrompt}"
//         `;
//         console.log('Prompt enviado a la IA:', prompt);

//         try {
//             await provider.sendPresenceUpdate('composing', ctx.key.remoteJid);
//             const response = await fetch("http://localhost:11434/api/generate", {
//                 method: "POST",
//                 headers: { "Content-Type": "application/json" },
//                 body: JSON.stringify({
//                     model: "phi3:mini",
//                     prompt: prompt,
//                     stream: false
//                 }),
//             });
//             await provider.sendPresenceUpdate('paused', ctx.key.remoteJid);

//             if (!response.ok) {
//                 await flowDynamic("Lo siento, no puedo procesar tu solicitud en este momento. Inténtalo más tarde.");
//                 console.error("Error en la respuesta de la API de Ollama:", response.status, response.statusText);
//                 return;
//             }

//             const data = await response.json();
//             console.log("Respuesta completa de la API de Ollama:", data);

//             // Extraer el JSON de la respuesta. El modelo puede devolverlo dentro de un bloque de código.
//             const aiResponse = data.response;
//             const jsonStartIndex = aiResponse.indexOf('{');
//             const jsonEndIndex = aiResponse.lastIndexOf('}');
//             let jsonString = '';

//             if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
//                 jsonString = aiResponse.substring(jsonStartIndex, jsonEndIndex + 1);
//             } else {
//                 console.error("No se pudo encontrar un JSON válido en la respuesta de la IA.");
//                 await flowDynamic("Hubo un problema procesando tu respuesta. La IA no devolvió el formato esperado.");
//                 return;
//             }

//             console.log("JSON extraído de la respuesta:", jsonString);

//             let extractedData;
//             try {
//                 // Eliminar comentarios de una sola línea (//...) antes de parsear el JSON
//                 const cleanedJsonString = jsonString.replace(/\/\/.*(?=,?\s*["}\]])/g, '');

//                 extractedData = JSON.parse(cleanedJsonString);
//             } catch (e) {
//                 console.error("Error al analizar el JSON extraído:", e);
//                 await flowDynamic("Hubo un problema procesando tu respuesta. Por favor, intenta de nuevo.");
//                 return;
//             }

//             console.log("Datos de la cita extraídos:", extractedData);
//             // Actualizamos el estado con los datos extraídos
//             await state.update({ appointmentData: { ...currentState, ...extractedData } });

//             // Redirigimos al flujo de resumen
//             return gotoFlow(flowSummary);

//         } catch (e) {
//             console.error("Error en la llamada a la API de Ollama:", e);
//             await flowDynamic("Lo siento, no puedo procesar tu solicitud en este momento. Inténtalo más tarde.");
//             return;
//         }
//     }
// );

// const flowSpecialties = addKeyword(['1'])
// .addAnswer("Vale listo, antes de empezar, necesito saber la especialidad de tu interés.")
// .addAnswer(
//     'Buscando especialidades...',
//     null,
//     async (ctx, { flowDynamic }) => {
//         const specialtiesList = await getSpecialties();
//         await flowDynamic(`Estas son las especialidades disponibles: \n\n* ${specialtiesList.join('\n* ')}`);
//         await flowDynamic('Para agendar una cita, primero escribe el numero de la esecialidad de tu interés.');
//     }
// );

// const welcomeFlow = addKeyword<Provider, Database>(
//     ['Hola', 'Hello', 'Buenas'], { sensitive: false }
// ).addAnswer(
//     '👋 ¡Hola! Soy la IA de Salu, tu asistente virtual para agendar citas médicas.',
//     {
//         delay: 800,
//     },
//     async (ctx, { flowDynamic }) => {
//         await flowDynamic('¿Qué te gustaría hacer hoy? \n\n*1.* Agendar una cita');
//     },
//     [flowSpecialties, flowAgenda]
// );


// const main = async () => {
//     const adapterFlow = createFlow([
//         welcomeFlow,
//         flowSpecialties,
//         flowAgenda,
//         flowSummary,
//         flowConfirmacion,
//         flowIA // Agregamos el nuevo flujo de IA a la lista de flujos
//     ]);
//     const adapterProvider = createProvider(Provider);
//     const adapterDB = new Database({
//         host: process.env.POSTGRES_DB_HOST,
//         user: process.env.POSTGRES_DB_USER,
//         database: process.env.POSTGRES_DB_NAME,
//         password: process.env.POSTGRES_DB_PASSWORD,
//         port: +process.env.POSTGRES_DB_PORT
//     });

//     const { httpServer } = await createBot({
//         flow: adapterFlow,
//         provider: adapterProvider,
//         database: adapterDB,
//     });

//     httpServer(+PORT);
// };

// main();
