# G-Chat Troubleshooting Bot & Admin Dashboard

Un chatbot de soporte técnico inteligente integrado en la plataforma de **Google Chat** para atender hasta 15 usuarios. El bot busca respuestas y procedimientos de mantenimiento exclusivamente a partir de documentos (texto, PDFs, imágenes y videos) guardados en una carpeta privada de **Google Drive**.

El sistema incluye una base de datos local SQLite con soporte vectorial RAG para búsquedas de similitud semántica y un **Panel de Administración Web** de diseño premium (glassmorphism) para controlar el bot en tiempo real.

---

## 🛠️ Requisitos Previos

Dado que este es un servidor Node.js autónomo, necesitas instalar el entorno de ejecución en tu máquina para iniciarlo localmente:

1. **Instalar Node.js**: Descarga e instala la versión LTS desde [nodejs.org](https://nodejs.org/). Esto agregará los comandos `node` y `npm` a tu terminal.
2. **Generar una API Key de Gemini**: Consigue una clave gratuita en [Google AI Studio](https://aistudio.google.com/).
3. **Cuenta de Servicio de Google Cloud**: Necesitarás crear un proyecto de Google Cloud y generar un archivo de credenciales de Cuenta de Servicio (`service-account.json`).

---

## 📁 Estructura del Proyecto

*   `server.js`: Punto de entrada del servidor Express.
*   `database.js`: Controlador SQLite (CRUD de archivos, registros de chat y similitud coseno).
*   `drive.js`: Conector con Google Drive usando Cuenta de Servicio.
*   `gemini.js`: Conector con la API oficial de Gemini (`@google/genai`) para resúmenes y embeddings vectoriales.
*   `sync.js`: Motor de sincronización diario y bajo demanda de la carpeta de Drive.
*   `chat.js`: Webhook para Google Chat, verificación de firmas JWT y estructuración de respuestas.
*   `test.js`: Script de autodiagnóstico del sistema.
*   `public/`: Archivos del panel web administrativo (`index.html`, `style.css`, `app.js`).

---

## 🚀 Guía de Configuración Paso a Paso

### Paso 1: Configurar Variables de Entorno
Crea un archivo llamado `.env` en la raíz del proyecto (basado en el archivo `.env.example` provisto) y completa las variables:

```ini
PORT=3000
GEMINI_API_KEY=tu_api_key_de_ai_studio
GOOGLE_DRIVE_FOLDER_ID=id_de_la_carpeta_de_drive
ADMIN_PASSWORD=contraseña_elegida_para_el_panel
GOOGLE_CHAT_PROJECT_NUMBER=numero_de_tu_proyecto_google_cloud
```

*   **ID de Carpeta de Drive**: Es el código al final de la URL cuando abres tu carpeta en el navegador (ej: `1A2b3c4d5e...`).
*   **Número de Proyecto de Cloud**: Requerido para verificar que los mensajes provengan genuinamente de Google Chat. Se encuentra en la página de inicio de tu Google Cloud Console.

### Paso 2: Configurar Acceso Privado a Google Drive
Para garantizar que **nadie más que el chatbot** pueda leer la información de tu carpeta:
1. Ve a [Google Cloud Console](https://console.cloud.google.com/).
2. Crea un proyecto nuevo.
3. Ve a **API y Servicios > Biblioteca** y habilita:
    *   **Google Drive API**
    *   **Google Chat API**
4. Ve a **IAM y administración > Cuentas de servicio** y crea una Cuenta de Servicio (ej. `chatbot-drive-reader`).
5. Entra a la cuenta de servicio creada, ve a la pestaña **Claves > Agregar clave > Crear clave nueva (JSON)**.
6. Se descargará un archivo `.json`. Cámbiale el nombre a `service-account.json` y guárdalo en la raíz de este proyecto.
7. Copia el correo de la cuenta de servicio (ej: `chatbot-drive-reader@mi-proyecto.iam.gserviceaccount.com`).
8. Ve a Google Drive, haz clic derecho sobre tu carpeta de administración, selecciona **Compartir** y agrega este correo como **Lector (Viewer)**.

*¡Listo! Tu carpeta ahora solo es accesible por ti (el administrador) y la cuenta de servicio del chatbot.*

### Paso 3: Instalar dependencias
Una vez que tengas Node.js instalado, abre tu terminal en esta carpeta y ejecuta:
```bash
npm install
```

### Paso 4: Ejecutar Pruebas de Diagnóstico
Puedes ejecutar el script de pruebas automatizadas para comprobar que tu base de datos SQLite y las integraciones con Gemini se inicializan correctamente:
```bash
npm test
```

### Paso 5: Iniciar el Servidor en Desarrollo
Para iniciar el servidor local con recarga automática al hacer cambios:
```bash
npm run dev
```

El servidor abrirá en:
*   🖥️ Panel Web de Administración: `http://localhost:3000` (Usa tu `ADMIN_PASSWORD` para entrar).
*   🤖 Webhook del Bot: `http://localhost:3000/api/chat` (Esta es la URL que debes registrar en la configuración de la API de Google Chat).

---

## ☁️ Despliegue en Producción e Integración con Google Chat

### 1. Despliegue en la Nube
Para que el bot pueda responder a los usuarios las 24 horas, debes hospedar el servidor Node.js en una plataforma accesible públicamente (como **Google Cloud Run**, **Render**, o un **servidor VPS**).
1. Sube tu código (excluyendo el archivo `.env` y `service-account.json` que contienen claves privadas).
2. En tu hosting, añade los valores del `.env` como variables de entorno de producción.
3. Asegúrate de obtener una URL HTTPS (ej. `https://mi-chatbot-soporte.render.com`).

### 2. Registrar el Bot en Google Chat
1. Abre la **Google Cloud Console** de tu proyecto.
2. Busca la **Google Chat API** en el buscador superior y entra en **Configuración**.
3. Rellena los datos de tu Bot:
    *   **Nombre de la aplicación**: Asistente de Soporte Técnico.
    *   **Avatar**: Sube un icono de robot.
    *   **Descripción**: Bot de resolución de problemas basados en manuales de Drive.
4. En **Funciones interactivas (Interactive features)**, marca **Habilitar características interactivas**.
5. En **Configuración de conexión**:
    *   Selecciona **URL de HTTP**.
    *   Pega tu URL de webhook de producción: `https://mi-chatbot-soporte.render.com/api/chat`
6. En **Visibilidad**:
    *   Marca **Hacer que esta aplicación de Chat esté disponible para personas y espacios específicos**.
    *   Añade los correos de tus 15 usuarios específicos para que solo ellos puedan encontrar y escribirle al chatbot.
7. Guarda los cambios.

*¡Ahora tus usuarios pueden buscar el bot por su nombre en Google Chat, agregarlo a un espacio o escribirle un mensaje directo!*

---

## 💻 Características del Panel de Administración
*   **Métricas en Vivo**: Revisa el número de archivos indexados, la cantidad de preguntas hechas por el personal y el estado del bot.
*   **Directorio de Conocimiento**: Explora los archivos de Drive que el bot ha "aprendido". Haz clic en cualquier fila para leer el resumen estructurado y detallado que hizo Gemini de ese manual, imagen o video.
*   **Sincronización Manual**: Haz clic en "Sincronizar Drive" en cualquier momento para forzar un escaneo inmediato de la carpeta de Drive sin esperar a la sincronización programada diaria (1:00 AM).
*   **Historial de Auditoría**: Revisa exactamente qué usuario de Google Chat preguntó algo, qué respuesta le dio el bot y qué manuales leyó el RAG para responderle.
*   **Playground**: Un chat interactivo privado en el panel donde puedes hacerle preguntas al bot de soporte técnico y ver qué manuales se están seleccionando y con qué nivel de similitud semántica.
