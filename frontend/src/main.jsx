import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import App from "./App";
import MobileApp from "./MobileApp";
import AdminPage from "./AdminPage";
import { AuthProvider } from "./AuthContext";
import { VenueListProvider, VenuePreferencesProvider } from "./usePreferences";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <VenueListProvider>
        <VenuePreferencesProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/mobile/*" element={<MobileApp />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/*" element={<App />} />
            </Routes>
          </BrowserRouter>
          <Analytics />
        </VenuePreferencesProvider>
      </VenueListProvider>
    </AuthProvider>
  </React.StrictMode>
);
