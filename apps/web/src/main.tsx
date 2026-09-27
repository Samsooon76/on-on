import React from "react";
import { IconContext } from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "@onoff/design-tokens/theme.css";
import "./styles.css";
import "./dash-theme.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IconContext.Provider value={{ weight: "regular", size: 20 }}><App /></IconContext.Provider>
  </React.StrictMode>,
);

