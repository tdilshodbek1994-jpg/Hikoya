import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, hasToken, onAuthLost, setToken, type Me } from "./api";
import { inTelegram, startParam, wa } from "./tg";

interface AuthState {
  me: Me | null;
  loading: boolean;
  error: string | null;
  startParam: string;
  refresh: () => Promise<void>;
  setMe: (m: Me) => void;
  can: (perm: string) => boolean;
  devLogin: (tgId: number) => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sp] = useState(startParam());

  const inflight = useRef<Promise<void> | null>(null);
  const login = useCallback(() => {
    if (!inflight.current) inflight.current = doLogin().finally(() => (inflight.current = null));
    return inflight.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function doLogin() {
    setError(null);
    try {
      if (inTelegram) {
        const r = await api<{ token: string; me: Me }>("/auth/telegram", { method: "POST", body: { init_data: wa!.initData, device_label: wa!.platform } });
        setToken(r.token);
        setMe(r.me);
      } else if (hasToken()) {
        setMe(await api<Me>("/me"));
      } else {
        const devId = Number(localStorage.getItem("hk_dev_id") || 0);
        if (devId) {
          const r = await api<{ token: string; me: Me }>("/auth/dev", { method: "POST", body: { telegram_user_id: devId } });
          setToken(r.token);
          setMe(r.me);
        }
      }
    } catch (e) {
      setToken(null);
      setError(e instanceof ApiError ? e.message : "Kirishda xatolik");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    onAuthLost(() => {
      setToken(null);
      if (inTelegram) login();
      else setMe(null);
    });
    login();
  }, [login]);

  const refresh = useCallback(async () => {
    setMe(await api<Me>("/me"));
  }, []);

  const devLogin = useCallback(async (tgId: number) => {
    localStorage.setItem("hk_dev_id", String(tgId));
    setLoading(true);
    const r = await api<{ token: string; me: Me }>("/auth/dev", { method: "POST", body: { telegram_user_id: tgId } });
    setToken(r.token);
    setMe(r.me);
    setLoading(false);
  }, []);

  const can = useCallback((perm: string) => !!me?.permissions.includes(perm), [me]);

  return <Ctx.Provider value={{ me, loading, error, startParam: sp, refresh, setMe, can, devLogin }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
