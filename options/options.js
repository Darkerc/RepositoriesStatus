const gitlabUrlInput = document.getElementById('gitlab-url');
const btnSave = document.getElementById('btn-save');
const messageEl = document.getElementById('message');

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const result = await chrome.storage.sync.get('gitlab_base_url');
  if (result.gitlab_base_url) {
    gitlabUrlInput.value = result.gitlab_base_url;
  }
});

btnSave.addEventListener('click', async () => {
  const url = gitlabUrlInput.value.trim().replace(/\/+$/, '');

  if (url && url !== 'https://gitlab.com') {
    // Validate URL format
    try {
      new URL(url);
    } catch {
      showMessage('Please enter a valid URL.', 'error');
      return;
    }

    // Request host permission for self-hosted instance
    try {
      const origin = new URL(url).origin + '/*';
      const granted = await chrome.permissions.request({
        origins: [origin],
      });
      if (!granted) {
        showMessage('Permission denied. Cannot access this GitLab instance.', 'error');
        return;
      }
    } catch (err) {
      showMessage(`Permission error: ${err.message}`, 'error');
      return;
    }

    await chrome.storage.sync.set({ gitlab_base_url: url });
  } else {
    // Reset to default
    await chrome.storage.sync.remove('gitlab_base_url');
  }

  showMessage('Settings saved.', 'success');
});

function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  setTimeout(() => {
    messageEl.className = 'message hidden';
  }, 3000);
}
