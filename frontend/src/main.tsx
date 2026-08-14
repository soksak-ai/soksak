import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { boot } from "./boot";

// Boot before the first render. Rendering first would let the opening frame
// decide what exists, and that decision would follow module evaluation order.
boot();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
