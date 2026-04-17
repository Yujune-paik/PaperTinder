import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import App from "./App";
import MobileApp from "./MobileApp";
import AdminPage from "./AdminPage";
import { AuthProvider } from "./AuthContext";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/mobile/*" element={<MobileApp />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/*" element={<App />} />
        </Routes>
      </BrowserRouter>
      <Analytics />
    </AuthProvider>
  </React.StrictMode>
);
