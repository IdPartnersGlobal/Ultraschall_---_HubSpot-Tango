const { app } = require('@azure/functions');

app.http('testTangoConnection', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            context.log("Iniciando proxy de conexión hacia Tango...");

            // 1. Leer variables de entorno (Basado en la estructura de TangoService)
            const baseUrl = process.env.TANGO_API_URL;
            const apiKey = process.env.TANGO_API_KEY;
            const company = process.env.TANGO_COMPANY || '3';

            if (!baseUrl || !apiKey) {
                return { 
                    status: 500, 
                    body: JSON.stringify({ error: "Faltan variables TANGO_API_URL o TANGO_API_KEY" }) 
                };
            }

            // 2. Construir la URL dinámica para Tango
            // Extraemos la URL original de la petición que entra desde Postman
            const incomingUrl = new URL(request.url);
            
            // Usamos un parámetro especial 'tangoPath' para definir la ruta (ej: Api/Get)
            // Si no lo mandan, por defecto asume 'Api/Get'
            const tangoPath = incomingUrl.searchParams.get('tangoPath') || 'Api/Get';
            
            // Borramos 'tangoPath' para que no viaje a Tango como parámetro inválido
            incomingUrl.searchParams.delete('tangoPath');
            
            // Armamos la URL final uniendo la IP de Claro + la ruta + los parámetros sobrantes (process, id, etc)
            const queryParamsString = incomingUrl.searchParams.toString();
            const targetUrl = queryParamsString 
                ? `${baseUrl}/${tangoPath}?${queryParamsString}` 
                : `${baseUrl}/${tangoPath}`;

            context.log(`Ejecutando petición hacia: ${targetUrl}`);

            // 3. Headers EXACTOS extraídos de TangoService.js
            const headers = {
                'ApiAuthorization': apiKey,
                'company': company,
                'Content-Type': 'application/json'
            };

            // 4. Disparar la petición a Claro Cloud
            const response = await fetch(targetUrl, {
                method: 'GET', // Para empezar a testear tablas usamos GET
                headers: headers
            });

            const responseText = await response.text();

            if (!response.ok) {
                context.log.error(`Tango devolvió error HTTP ${response.status}`);
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: "El servidor de Tango rechazó la petición",
                        statusCode: response.status,
                        tangoResponse: responseText
                    })
                };
            }

            // 5. Devolver la respuesta exitosa al Postman
            let responseData;
            try {
                responseData = JSON.parse(responseText);
            } catch (e) {
                responseData = responseText;
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(responseData)
            };

        } catch (error) {
            context.log.error("Error fatal en el Proxy:", error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Fallo de red o código', details: error.message })
            };
        }
    }
});