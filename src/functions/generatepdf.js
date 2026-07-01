const { app } = require('@azure/functions');

app.http('testTangoConnection', {
    // Permitimos GET y POST desde tu Postman
    methods: ['GET', 'POST'],
    authLevel: 'anonymous', 
    handler: async (request, context) => {
        try {
            context.log("Iniciando prueba de conexión hacia Tango...");

            // 1. Leer la URL base desde las variables de entorno
            const baseUrl = process.env.TANGO_API_URL;
            const token = process.env.TANGO_API_TOKEN;

            if (!baseUrl) {
                return { 
                    status: 500, 
                    body: JSON.stringify({ error: "Falta configurar TANGO_API_URL en las variables de entorno." }) 
                };
            }

            // 2. Obtener qué endpoint/tabla queremos consultar dinámicamente desde Postman
            // Ejemplo: Si en Postman mandas ?endpoint=api/v1/articulos, tomará ese valor
            const endpoint = request.query.get('endpoint') || ''; 
            
            // Armamos la URL final destino
            const targetUrl = `${baseUrl}/${endpoint}`;
            context.log(`Ejecutando GET hacia: ${targetUrl}`);

            // 3. Configurar los headers para enviar a Tango (opcional si requiere token)
            const headers = {
                "Content-Type": "application/json"
            };
            if (token) {
                headers["Authorization"] = `Bearer ${token}`; // O el formato que use Tango
            }

            // 4. Hacer la petición GET al servidor de Claro Cloud
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: headers
            });

            // 5. Capturar la respuesta
            const responseText = await response.text();

            if (!response.ok) {
                context.log.error(`El servidor de Tango devolvió un error: ${response.status}`);
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: "Error en el servidor de destino (Claro Cloud)",
                        statusCode: response.status,
                        tangoResponse: responseText
                    })
                };
            }

            // Intentar parsear a JSON si la respuesta es válida
            let responseData;
            try {
                responseData = JSON.parse(responseText);
            } catch (e) {
                responseData = responseText; // Si no es JSON (ej. XML o texto plano), lo dejamos como string
            }

            // 6. Devolver la info obtenida a tu Postman
            context.log("Petición exitosa, devolviendo datos a Postman.");
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: targetUrl,
                    data: responseData
                })
            };

        } catch (error) {
            context.log.error("Hubo un error de red o de código:", error);
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    error: 'Error interno en la Azure Function', 
                    details: error.message 
                })
            };
        }
    }
});