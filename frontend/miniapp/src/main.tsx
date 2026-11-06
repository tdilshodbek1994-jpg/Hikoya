import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { ToastProvider } from "./components/ui";
import { AuthProvider } from "./lib/auth";
import { initTelegram } from "./lib/tg";
import "./styles.css";

initTelegram();

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (n, e: any) => n < 2 && (!e?.status || e.status >= 500), refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
