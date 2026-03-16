# Extensión de navegador para contribuciones GitHub + GitLab

**No existe actualmente ninguna extensión de navegador que combine los gráficos de contribución de GitHub y GitLab en una sola vista**, lo que representa una oportunidad clara de desarrollo. La buena noticia: ambas plataformas exponen datos suficientes a través de sus APIs para construir esta herramienta. GitHub ofrece datos de contribución pre-agregados mediante su API GraphQL (`contributionsCollection`), mientras que GitLab proporciona un endpoint semi-privado (`/users/:username/calendar.json`) que devuelve conteos diarios directamente. La extensión puede construirse con Manifest V3, autenticación OAuth con PKCE, y un heatmap SVG generado con vanilla JavaScript — sin dependencias pesadas — para un paquete total inferior a **10 KB** de código propio.

---

## La API GraphQL de GitHub es la única vía para obtener el contribution graph

La REST API de GitHub **no tiene ningún endpoint** que devuelva los datos del calendario de contribuciones. El único mecanismo oficial es la **API GraphQL** a través del objeto `contributionsCollection`. La consulta para el usuario autenticado usa el campo especial `viewer`, que no requiere pasar un nombre de usuario:

```graphql
query($from: DateTime, $to: DateTime) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
            date
            color
            contributionLevel
          }
        }
      }
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
    }
  }
}
```

Cada `contributionDay` devuelve el **conteo exacto**, la **fecha** en formato `YYYY-MM-DD`, el **color hex** que GitHub usa (por ejemplo `#216e39` para el nivel más alto), y un enum `contributionLevel` con cinco valores: `NONE`, `FIRST_QUARTILE`, `SECOND_QUARTILE`, `THIRD_QUARTILE` y `FOURTH_QUARTILE`. La escala es relativa a la actividad propia del usuario, no universal.

Los parámetros `from` y `to` aceptan fechas ISO 8601 y permiten consultar un **máximo de 1 año** por petición. Si se omiten, devuelve los últimos 365 días. Para datos multi-año, se necesitan consultas secuenciales. Las contribuciones incluyen commits al branch principal, issues abiertos, pull requests, reviews y discusiones en repositorios no-fork.

**Autenticación mínima**: un Personal Access Token clásico con el scope **`read:user`** es suficiente para acceder a `contributionsCollection`. El prefijo del token es `ghp_`. Para ver detalles de repos privados en los breakdowns, se necesita también el scope `repo`. La tasa de peticiones permitida es **5,000 puntos/hora** para GraphQL, y una consulta simple de contribuciones cuesta típicamente **1 punto**.

---

## GitLab ofrece dos caminos: la Events API oficial y un endpoint oculto más práctico

GitLab proporciona dos mecanismos para obtener datos de actividad, con diferencias significativas en practicidad.

**El camino rápido** es el endpoint semi-privado `/users/:username/calendar.json`, que es exactamente lo que el frontend de GitLab usa para renderizar su heatmap. Devuelve un objeto JSON plano mapeando fechas a conteos diarios de los últimos 12 meses:

```json
{"2025-01-15": 3, "2025-02-01": 7, "2025-03-09": 12}
```

Este endpoint funciona tanto en gitlab.com como en instancias self-hosted, pero **no es parte de la API pública documentada** y podría cambiar sin aviso. Existe un issue abierto (#322153) para formalizarlo como `GET /users/:id/contributions`.

**El camino oficial** es la Events API en `GET /api/v4/events` para el usuario autenticado, o `GET /api/v4/users/:id/events` para un usuario específico. Soporta filtros por `action` (pushed, created, merged, commented, closed, etc.), `target_type` (issue, merge_request, milestone), y rango de fechas con `before`/`after`. La limitación principal es que **devuelve eventos individuales, no conteos agregados** — la extensión debe paginar todos los resultados y agruparlos por fecha del lado del cliente. Los eventos se retienen por **3 años**, pero el calendario solo muestra 12 meses.

La autenticación requiere un PAT con scope **`read_user`** como mínimo (o `read_api` para acceso más amplio). El token se envía mediante el header `PRIVATE-TOKEN: <token>` o como `Authorization: Bearer <token>`. GitLab permite **2,000 peticiones/minuto** por usuario autenticado en gitlab.com, significativamente más generoso que GitHub.

| Aspecto | GitHub | GitLab |
|---------|--------|--------|
| **Endpoint principal** | GraphQL `contributionsCollection` | `/users/:username/calendar.json` (semi-privado) |
| **Datos pre-agregados** | Sí (conteo diario + nivel + color) | Sí con calendar.json / No con Events API |
| **Scope mínimo** | `read:user` | `read_user` |
| **Rate limit** | 5,000 puntos/hora | 2,000 req/minuto |
| **Rango temporal** | Máximo 1 año por consulta | 12 meses (calendar) / 3 años (events) |
| **Self-hosted** | No aplica (github.com only) | Mismos endpoints, diferente base URL |

---

## Arquitectura de la extensión con Manifest V3 y OAuth con PKCE

La extensión requiere **Manifest V3** (obligatorio para Chrome). La estructura fundamental se compone de tres piezas: un service worker (`background.js`) que gestiona autenticación y llamadas API, un popup (`popup.html/popup.js`) que renderiza la UI, y `chrome.storage` para persistencia.

```json
{
  "manifest_version": 3,
  "name": "Contribution Heatmap",
  "version": "1.0.0",
  "action": { "default_popup": "popup/popup.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["identity", "storage"],
  "host_permissions": [
    "https://api.github.com/*",
    "https://github.com/*",
    "https://gitlab.com/*"
  ],
  "browser_specific_settings": {
    "gecko": { "id": "contribution-heatmap@example.com" }
  }
}
```

El flujo OAuth usa `chrome.identity.launchWebAuthFlow()`, que abre una ventana sandbox del navegador para la autenticación. La URL de callback tiene formatos distintos: **`https://<id>.chromiumapp.org/`** en Chrome y **`https://<id>.extensions.allizom.org/`** en Firefox, lo que obliga a registrar ambas en las aplicaciones OAuth de GitHub/GitLab (o usar apps OAuth separadas por navegador).

**PKCE es el flujo recomendado** porque elimina la necesidad de incluir un `client_secret` en el código de la extensión (que es inspeccionable por cualquiera). GitLab soporta PKCE nativamente y GitHub lo añadió en julio 2025. El flujo genera un `code_verifier` aleatorio, calcula un `code_challenge` como SHA-256 del verifier, y lo incluye en la URL de autorización. Al intercambiar el código por token, se envía el `code_verifier` original en lugar del `client_secret`:

```javascript
async function authenticateWithPKCE(provider) {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = generateRandomString(32);
  
  const authUrl = buildAuthUrl(provider, {
    client_id: CONFIG[provider].clientId,
    redirect_uri: chrome.identity.getRedirectURL(`${provider}_callback`),
    scope: provider === 'github' ? 'read:user' : 'read_user',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });
  
  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl, interactive: true
  });
  
  // Validar state, extraer code, intercambiar por token con code_verifier
}
```

Para **almacenamiento seguro de tokens**, `chrome.storage.session` mantiene los datos solo en memoria (se borran al cerrar el navegador), ideal para tokens activos. `chrome.storage.local` persiste en disco pero **no está encriptado** — úsalo para datos de contribución cacheados, no para tokens sin cifrar. Si se necesita persistencia de tokens entre reinicios, cifra con la Web Crypto API (AES-GCM) antes de almacenar en `chrome.storage.local`.

Para **compatibilidad cross-browser**, la librería `webextension-polyfill` de Mozilla permite escribir código con `browser.*` (Promises nativas) que funciona tanto en Chrome como en Firefox. Firefox requiere establecer un ID fijo en `browser_specific_settings.gecko.id` para que `identity.getRedirectURL()` devuelva una URL consistente.

---

## Visualización SVG ligera como mejor opción para extensiones

Las librerías populares como **Cal-Heatmap** (que depende de D3.js, ~250KB minificado) son demasiado pesadas para una extensión de navegador. La recomendación es **generar el heatmap SVG con vanilla JavaScript**, lo que resulta en un paquete de apenas **3-5 KB** y renderiza en menos de 5ms.

El popup de Chrome tiene un límite de **800×600 píxeles**. Un año de datos de contribución con celdas de 11px y gap de 3px ocupa aproximadamente **720×110 píxeles**, por lo que cabe perfectamente. La implementación genera ~365 elementos `<rect>` SVG posicionados en una grilla de 53 columnas (semanas) × 7 filas (días):

```javascript
function renderCombinedHeatmap(container, githubData, gitlabData) {
  const svg = createSVG(720, 110);
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 1);
  
  for (let i = 0; i < 365; i++) {
    const date = addDays(startDate, i);
    const dateStr = formatDate(date);
    const ghCount = githubData[dateStr] || 0;
    const glCount = gitlabData[dateStr] || 0;
    const total = ghCount + glCount;
    
    const week = Math.floor(i / 7);
    const day = date.getDay();
    const color = getColor(total, ghCount, glCount);
    
    appendRect(svg, week * 14, day * 14, 11, 11, color, 2);
  }
  container.appendChild(svg);
}
```

Para **diferenciar visualmente** las contribuciones de cada plataforma, las estrategias más efectivas son:

- **Escala de colores por fuente**: verde para GitHub, azul/morado para GitLab, y un color mezclado (por ejemplo, teal) cuando ambas tienen actividad el mismo día
- **Tooltip con desglose**: un solo color basado en el total, pero al pasar el mouse se muestra "GitHub: 5, GitLab: 3"
- **Celda dividida**: la mitad superior con el color de GitHub, la inferior con GitLab

La estrategia del tooltip combinado con colores diferenciados es la más limpia visualmente y la más fácil de implementar.

---

## Caching, rate limits y decisiones técnicas clave

**¿Se pueden obtener los datos directamente o hay que calcularlos?** En GitHub, los datos vienen **completamente pre-agregados** de la API GraphQL — conteo diario, nivel de intensidad y color hex exacto. No se necesita cálculo alguno. En GitLab, el endpoint `calendar.json` también devuelve conteos pre-agregados. Solo si se usa la Events API oficial se necesita agregar manualmente los eventos por fecha.

**Estrategia de caching**: los datos de contribución cambian poco durante el día. Un TTL de **1-4 horas** en `chrome.storage.local` evita peticiones repetidas al abrir el popup. El patrón recomendado es intentar leer del caché al abrir el popup, renderizar inmediatamente si hay datos, y refrescar en segundo plano si el caché ha expirado:

```javascript
const CACHE_TTL = 3600000; // 1 hora
async function getCachedOrFetch(key, fetchFn) {
  const cached = await chrome.storage.local.get(key);
  if (cached[key] && Date.now() - cached[key].timestamp < CACHE_TTL) {
    return cached[key].data; // Render inmediato
  }
  const fresh = await fetchFn();
  await chrome.storage.local.set({ [key]: { data: fresh, timestamp: Date.now() } });
  return fresh;
}
```

**Rate limits en la práctica**: con un caché de 1 hora, la extensión haría como máximo **24 peticiones/día** a cada servicio — insignificante frente a los 5,000 puntos/hora de GitHub o los 2,000 req/minuto de GitLab. Incluso sin caché, los límites son difíciles de alcanzar con uso normal.

**Decisiones arquitectónicas recomendadas**: usar `chrome.alarms` en el service worker para refrescar datos periódicamente en segundo plano (aunque el service worker se suspenda, las alarmas lo reactivan). Para instancias self-hosted de GitLab, añadir un campo configurable en la página de opciones de la extensión con la base URL personalizada, y usar `optional_host_permissions` en el manifest para solicitar permisos de dominio dinámicamente mediante `chrome.permissions.request()`.

---

## Conclusión

El proyecto es técnicamente viable con un stack sorprendentemente ligero. Las piezas clave son: **GraphQL con `viewer.contributionsCollection`** para GitHub (1 petición = 1 año completo de datos), **`calendar.json`** para GitLab (pragmático aunque no oficial), **OAuth con PKCE** para ambas plataformas desde `chrome.identity.launchWebAuthFlow()`, y un **renderer SVG de ~200 líneas** sin dependencias externas. El gap de mercado es real — todas las herramientas existentes que combinan contribuciones de múltiples plataformas son aplicaciones web o herramientas CLI, ninguna es una extensión de navegador. La combinación de caché agresivo en `chrome.storage.local`, tokens en `chrome.storage.session`, y el polyfill de WebExtensions permitiría una extensión cross-browser funcional con un bundle total inferior a 50 KB.