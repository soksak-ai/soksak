import { usePlugins } from "../state/plugins";
import { useUi } from "../state/ui";
import { PluginConsentModal } from "./PluginConsentModal";

// plugin.consent.preview command 가 띄우는 동의 모달 호스트 — App 레벨 상시 마운트(사이드바 마운트
// 여부 무관). 검사 전용(preview): 권한·기여·종속성을 표시만 하고 활성화는 안 한다. 미설치/없는 id 면 무표시.
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
