const { app } = require('@azure/functions');

app.http('testTangoConnection', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const requestId = Math.random().toString(36).substring(2, 9).toUpperCase();
        const startTime = Date.now();

        context.log(`======================================================================`);
        context.log(`🚀 [START] [REQ-${requestId}] Iniciando Proxy de Prueba hacia Tango ERP`);
        context.log(`======================================================================`);

        try {
            // 1. LEER Y NORMALIZAR VARIABLES DE ENTORNO
            const baseUrl = process.env.TANGO_API_URL;
            const apiKey = process.env.TANGO_API_KEY;
            const company = process.env.TANGO_COMPANY || '1';

            // Enmascaramos la API Key para mostrarla segura en los logs de Azure
            const maskedKey = apiKey 
                ? `${apiKey.substring(0, 6)}...${apiKey.substring(apiKey.length - 4)}` 
                : '❌ NO CONFIGURADA';

            context.log(`📋 [ENV-CONFIG] Carga de variables de entorno:`);
            context.log(`   • URL Base Destino : ${baseUrl || '❌ NO CONFIGURADA'}`);
            context.log(`   • API Authorization: ${maskedKey}`);
            context.log(`   • Código Empresa   : ${company}`);

            if (!baseUrl || !apiKey) {
                context.log.error(`❌ [ERR-CONFIG] [REQ-${requestId}] Faltan configuraciones críticas en las Application Settings.`);
                return { 
                    status: 500, 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: "Faltan variables TANGO_API_URL o TANGO_API_KEY en Azure" }) 
                };
            }

            // 2. PROCESAR URL ENTRANTE Y CONSTRUIR DESTINO
            const incomingUrl = new URL(request.url);
            const tangoPath = incomingUrl.searchParams.get('tangoPath') || 'Api/Get';
            
            // Limpiamos el parámetro interno del proxy para que no ensucie la query de Tango
            incomingUrl.searchParams.delete('tangoPath');
            
            const queryParamsString = incomingUrl.searchParams.toString();
            const targetUrl = queryParamsString 
                ? `${baseUrl}/${tangoPath}?${queryParamsString}` 
                : `${baseUrl}/${tangoPath}`;

            context.log(`🔌 [ROUTING-INFO] Mapeo de la petición proxy:`);
            context.log(`   • Ruta interna Tango: ${tangoPath}`);
            context.log(`   • Parámetros Query  : ${queryParamsString || 'Ninguno'}`);
            context.log(`   • URL Final Target  : ${targetUrl}`);

            // 3. SELECCIÓN DE CABECERAS (HEADERS)
            const headers = {
                'ApiAuthorization': apiKey,
                'company': company,
                'Content-Type': 'application/json'
            };

            context.log(`🔒 [HEADERS-OUT] Cabeceras enviadas al Firewall de Claro Cloud:`);
            context.log(`   • ApiAuthorization : ${maskedKey}`);
            context.log(`   • company          : ${company}`);
            context.log(`   • Content-Type     : application/json`);

            // 4. DISPARAR PETICIÓN Y MEDIR LATENCIA
            context.log(`🛰️ [HTTP-REQUEST] Enviando petición externa... Esperando respuesta de Claro Cloud...`);
            
            const tangoStartTime = Date.now();
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: headers
            });
            const tangoEndTime = Date.now();
            const latency = tangoEndTime - tangoStartTime;

            // 5. EVALUAR RESPUESTA DEL SERVIDOR
            context.log(`⏱️ [HTTP-RESPONSE] Respuesta recibida:`);
            context.log(`   • Estado HTTP   : ${response.status} ${response.statusText}`);
            context.log(`   • Latencia Red  : ${latency}ms`);

            const responseText = await response.text();

            if (!response.ok) {
                context.log.error(`⚠️ [ERR-TANGO] El servidor de Tango rechazó la consulta (Fuera de rango 2xx).`);
                context.log.error(`   • Payload Error : ${responseText}`);
                
                return {
                    status: response.status,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: "fail",
                        message: "El servidor de Tango devolvió un error.",
                        statusCode: response.status,
                        latencyMs: latency,
                        tangoRawResponse: responseText
                    })
                };
            }

            // 6. PARSEAR CUERPO EXITOSO
            let responseData;
            try {
                responseData = JSON.parse(responseText);
                context.log(`✅ [PARSER-SUCCESS] El cuerpo recibido es un JSON válido.`);
                if (responseData.resultData && Array.isArray(responseData.resultData.list)) {
                    context.log(`   • Registros encontrados: ${responseData.resultData.list.length}`);
                }
            } catch (e) {
                context.log(`🔤 [PARSER-WARN] El cuerpo no es JSON plano. Devolviendo texto crudo.`);
                responseData = responseText;
            }

            const totalDuration = Date.now() - startTime;
            context.log(`🏁 [END] [REQ-${requestId}] Proceso finalizado con éxito. Tiempo de ejecución total de la función: ${totalDuration}ms\n`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: "success",
                    proxyTarget: targetUrl,
                    latencyMs: latency,
                    totalFunctionTimeMs: totalDuration,
                    result: responseData
                })
            };

        } catch (error) {
            const totalDuration = Date.now() - startTime;
            context.log.error(`🚨 [FATAL-ERROR] [REQ-${requestId}] Excepción de red o caída de conexión bloqueada.`);
            context.log.error(`   • Mensaje Error : ${error.message}`);
            context.log.error(`   • Stack Trace   : ${error.stack}`);
            context.log.error(`⏱️ [FATAL-TIME] Duración hasta el crasheo: ${totalDuration}ms\n`);

            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    status: "error",
                    message: "Error de conexión o timeout intentando alcanzar Claro Cloud.", 
                    details: error.message,
                    totalFunctionTimeMs: totalDuration
                })
            };
        }
    }
});