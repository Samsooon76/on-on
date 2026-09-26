import React from "react";
import { IconContext } from "@phosphor-icons/react";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IconContext.Provider value={{ weight: "light", size: 20 }}><App /></IconContext.Provider>
  </React.StrictMode>,
);

