import { usePlugins } from "../state/plugins";
import { useContractSelection } from "../state/contractSelection";
import { selectableContracts } from "../plugins/contractResolve";
import { localize, useT } from "../i18n";

// Per-contract implementer selection — one dropdown per contract with two or more active implementers
// (e.g. soksak-spec-plugin-terminal → xterm/ghostty). The core has no contract-specific logic: it
// enumerates whatever selectableContracts found (label = contract id verbatim) and the user picks the
// implementer. Contracts with a single implementer are not shown (nothing to pick). No selection and a
// stale selection both fall back to the first entry (discovery order).
export function ContractEngineSettings() {
  const t = useT();
  // Re-render on active-plugin or selection change (mounted only while the modal is open).
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
