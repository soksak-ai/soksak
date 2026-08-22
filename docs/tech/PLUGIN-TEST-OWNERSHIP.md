# Plugin test ownership

Core does not read a user's development home as test input and does not maintain a
cross-repository manifest exemption list. Each plugin repository validates its own manifest against
the published spec. The installed acceptance repository verifies selected immutable releases as a
black-box composition.

Core owns only its parser facade, installation boundary, runtime loading, and minimal manifests
embedded directly in tests of those Core responsibilities. A plugin source manifest remains with
its owner. Historical corpus measurements are records, not live gates or migration fallbacks.
