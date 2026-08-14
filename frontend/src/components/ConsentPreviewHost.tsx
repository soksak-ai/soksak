import { usePlugins } from "../state/plugins";
import { useUi } from "../state/ui";
import { PluginConsentModal } from "./PluginConsentModal";

// Consent modal host opened by the plugin.consent.preview command — mounted at App level at all times,
// independent of sidebar mount. Preview only: shows permissions, contributions and dependencies, never
// activates. An uninstalled or unknown id renders nothing.
export function ConsentPreviewHost() {
  const id = useUi((s) => s.consentPreviewId);
  const setPreview = useUi((s) => s.setConsentPreview);
  const plugin = usePlugins((s) => (id ? s.plugins[id] : undefined));
  if (!id || !plugin) return null;
  return (
    <PluginConsentModal
      plugin={plugin}
      preview
      onConsent={() => setPreview(null)}
      onClose={() => setPreview(null)}
    />
  );
}
