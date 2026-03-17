/**
 * @fileoverview Script de la página de opciones de la extensión.
 *
 * Permite al usuario configurar:
 * - La URL base de su instancia de GitLab (para instancias self-hosted).
 *   Por defecto se usa 'https://gitlab.com', pero empresas que usen su propia
 *   instancia pueden configurar una URL personalizada aquí.
 *
 * Flujo de configuración:
 * 1. Al cargar la página, se lee la URL guardada en chrome.storage.sync y se muestra.
 * 2. El usuario modifica la URL y hace clic en "Guardar".
 * 3. Se valida que la URL sea válida.
 * 4. Se solicita permiso de acceso al host (necesario para instancias self-hosted).
 * 5. Si el permiso es concedido, se guarda la URL en chrome.storage.sync.
 * 6. Si la URL es vacía o la por defecto (gitlab.com), se elimina la configuración
 *    personalizada (se usará la URL por defecto).
 *
 * Nota: chrome.storage.sync se sincroniza entre dispositivos del usuario,
 * a diferencia de chrome.storage.local que es solo local.
 */

/** @type {HTMLInputElement} Campo de texto para la URL base de GitLab */
const gitlabUrlInput = document.getElementById('gitlab-url');

/** @type {HTMLButtonElement} Botón para guardar la configuración */
const btnSave = document.getElementById('btn-save');

/** @type {HTMLElement} Elemento para mostrar mensajes de éxito/error */
const messageEl = document.getElementById('message');

/**
 * Al cargar el DOM, leer la configuración guardada y mostrarla en el formulario.
 * Si no hay URL personalizada guardada, el campo queda vacío (se usará gitlab.com).
 */
document.addEventListener('DOMContentLoaded', async () => {
  const result = await chrome.storage.sync.get('gitlab_base_url');
  if (result.gitlab_base_url) {
    gitlabUrlInput.value = result.gitlab_base_url;
  }
});

/**
 * Handler del botón "Guardar": valida, solicita permisos y guarda la URL.
 */
btnSave.addEventListener('click', async () => {
  // Limpiar espacios y barras finales de la URL
  const url = gitlabUrlInput.value.trim().replace(/\/+$/, '');

  if (url && url !== 'https://gitlab.com') {
    // Caso: URL personalizada (instancia self-hosted)

    // Validar que la URL tenga un formato correcto
    try {
      new URL(url);
    } catch {
      showMessage('Please enter a valid URL.', 'error');
      return;
    }

    // Solicitar permiso de acceso al host de la instancia de GitLab.
    // Esto es necesario porque la extensión necesita hacer fetch() a ese dominio,
    // y Chrome bloquea las peticiones a hosts no declarados en el manifiesto.
    try {
      const origin = new URL(url).origin + '/*';
      const granted = await chrome.permissions.request({
        origins: [origin],
      });
      if (!granted) {
        // El usuario denegó el permiso — no se puede acceder a esa instancia
        showMessage('Permission denied. Cannot access this GitLab instance.', 'error');
        return;
      }
    } catch (err) {
      showMessage(`Permission error: ${err.message}`, 'error');
      return;
    }

    // Guardar la URL personalizada en storage sincronizado
    await chrome.storage.sync.set({ gitlab_base_url: url });
  } else {
    // Caso: URL vacía o gitlab.com (la por defecto)
    // Eliminar la configuración personalizada para usar el valor por defecto
    await chrome.storage.sync.remove('gitlab_base_url');
  }

  showMessage('Settings saved.', 'success');
});

/**
 * Muestra un mensaje temporal al usuario (éxito o error).
 * El mensaje se oculta automáticamente después de 3 segundos.
 *
 * @param {string} text - Texto del mensaje a mostrar.
 * @param {string} type - Tipo de mensaje ('success' o 'error') para estilos CSS.
 */
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  // Ocultar el mensaje después de 3 segundos
  setTimeout(() => {
    messageEl.className = 'message hidden';
  }, 3000);
}
