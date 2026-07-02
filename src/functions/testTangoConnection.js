const { app } = require('@azure/functions');

app.http('testTangoConnection', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const requestId = Math.random().toString(36).substring(2, 9).toUpperCase();
        const startTime = Date.now();
        
        // Detectamos dinámicamente si Postman envió un GET o un POST
        const reqMethod = request.method.toUpperCase(); 

        context.log(`======================================================================`);
        context.log(`🚀 [START] [REQ-${requestId}] Iniciando Proxy hacia Tango ERP | Método: ${reqMethod}`);
        context.log(`======================================================================`);

        try {
            // 1. LEER Y NORMALIZAR VARIABLES DE ENTORNO
            const baseUrl = process.env.TANGO_API_URL;
            const apiKey = process.env.TANGO_API_KEY;
            const company = process.env.TANGO_COMPANY || '1';

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
            
            // Lógica inteligente: Si es POST por defecto asume 'Api/Create', si es GET asume 'Api/Get'
            const defaultPath = reqMethod === 'POST' ? 'Api/Create' : 'Api/Get';
            const tangoPath = incomingUrl.searchParams.get('tangoPath') || defaultPath;
            
            incomingUrl.searchParams.delete('tangoPath'); // Lo borramos para que no ensucie a Tango
            
            const queryParamsString = incomingUrl.searchParams.toString();
            const targetUrl = queryParamsString 
                ? `${baseUrl}/${tangoPath}?${queryParamsString}` 
                : `${baseUrl}/${tangoPath}`;

            context.log(`🔌 [ROUTING-INFO] Mapeo de la petición proxy:`);
            context.log(`   • Ruta interna Tango: ${tangoPath}`);
            context.log(`   • Parámetros Query  : ${queryParamsString || 'Ninguno'}`);
            context.log(`   • URL Final Target  : ${targetUrl}`);

            // 3. SELECCIÓN DE CABECERAS EXACTAS DE TANGO
            const headers = {
                'ApiAuthorization': apiKey,
                'company': company,
                'Content-Type': 'application/json'
            };

            // 4. PREPARAR LAS OPCIONES DEL FETCH BASADO EN EL MÉTODO
            const fetchOptions = {
                method: reqMethod,
                headers: headers
            };

            // Si es un POST, extraemos el body de Postman y lo empaquetamos
            if (reqMethod === 'POST') {
                try {
                    const requestBodyText = await request.text();
                    fetchOptions.body = requestBodyText; // Se lo pasamos directo a Tango
                    
                    context.log(`📦 [PAYLOAD-OUT] Cuerpo de la petición detectado:`);
                    context.log(`   • Tamaño Payload : ${requestBodyText.length} bytes`);
                    // Logueamos un preview seguro (hasta 300 caracteres) para no saturar la consola
                    const bodyPreview = requestBodyText.length > 300 
                        ? requestBodyText.substring(0, 300) + '... [TRUNCADO]' 
                        : requestBodyText;
                    context.log(`   • Preview Body   : ${bodyPreview}`);

                } catch (err) {
                    context.log.error(`❌ [ERR-BODY] No se pudo leer el cuerpo de la petición enviada desde Postman.`);
                }
            }

            // 5. DISPARAR PETICIÓN Y MEDIR LATENCIA
            context.log(`🛰️ [HTTP-REQUEST] Enviando petición externa... Esperando respuesta de Claro Cloud...`);
            
            const tangoStartTime = Date.now();
            const response = await fetch(targetUrl, fetchOptions);
            const tangoEndTime = Date.now();
            const latency = tangoEndTime - tangoStartTime;

            // 6. EVALUAR RESPUESTA DEL SERVIDOR
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

            // 7. PARSEAR CUERPO EXITOSO
            let responseData;
            try {
                responseData = JSON.parse(responseText);
                context.log(`✅ [PARSER-SUCCESS] El cuerpo recibido es un JSON válido.`);
            } catch (e) {
                context.log(`🔤 [PARSER-WARN] El cuerpo no es JSON plano. Devolviendo texto crudo.`);
                responseData = responseText;
            }

            const totalDuration = Date.now() - startTime;
            context.log(`🏁 [END] [REQ-${requestId}] Proceso finalizado con éxito. Tiempo total: ${totalDuration}ms\n`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: "success",
                    proxyTarget: targetUrl,
                    method: reqMethod,
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