import { usePlugins } from "../state/plugins";
import { useContractSelection } from "../state/contractSelection";
import { selectableContracts } from "../plugins/contractResolve";
import { localize, useT } from "../i18n";

// 계약별 구현체 선택 — 활성 구현체가 둘 이상인 계약(예: soksak-spec-plugin-terminal@1 → xterm/ghostty)마다
// 드롭다운. 코어는 계약의 의미를 모른다 — selectableContracts 가 발견한 계약을 제네릭하게 열거하고
// (계약 id 그대로 라벨), 사용자가 구현체를 고른다. 구현체가 하나뿐인 계약은 노출하지 않는다
// (고를 게 없다). 선택 없음·stale 선택은 첫 항목으로 폴백(발견 순서).
export function ContractEngineSettings() {
  const t = useT();
  // 활성 플러그인/선택 변경 시 재렌더(모달 열림 동안만 마운트).
  const plugins = usePlugins((s) => s.plugins);
  const selected = useContractSelection((s) => s.selected);
  const select = useContractSelection((s) => s.select);
  const contracts = selectableContracts();
  if (contracts.length === 0) return null;
  const nameOf = (id: string) => (plugins[id] ? localize(plugins[id].manifest.name) : id);
  return (
    <>
      <div className="dsec">{t("settings.contracts")}</div>
      {contracts.map(({ contract, implementers }) => {
        const chosen = selected[contract];
        const current =
          chosen && implementers.includes(chosen) ? chosen : implementers[0];
        return (
          <div className="drow" key={contract}>
            <span className="drow-label" title={contract}>
              {contract}
            </span>
            <select
              className="dctl"
              value={current}
              onChange={(e) => select(contract, e.target.value)}
            >
              {implementers.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </>
  );
}
