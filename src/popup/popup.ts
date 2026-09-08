import { loadSettings, saveSettings } from "../shared/storage";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;

async function main() {
  const s = await loadSettings();
  enabledEl.checked = s.enabled;
  enabledEl.addEventListener("change", () => {
    void saveSettings({ enabled: enabledEl.checked });
  });
}

void main();
