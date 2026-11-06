import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { routeForParam } from "../lib/routes";
import { Empty, Spinner, TopBar } from "../components/ui";
import { get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { relTime, useT } from "../lib/i18n";

/** E-19: in-app notification centre, independent of bot messages. */
export default function Notifications() {
  const t = useT();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ["notifications"], queryFn: () => get<any[]>("/notifications") });
  useEffect(() => {
    if (data?.some((n) => !n.read)) post("/notifications/read", {}).then(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  return (
    <div className="page">
      <TopBar title={t("Bildirishnomalar")} />
      {isLoading ? <Spinner /> : !data?.length ? <Empty icon="🔔" title={t("Hozircha yangilik yo'q")} /> : (
        <div className="list" style={{ margin: "0 16px" }}>
          {data.map((n) => (
            <button key={n.id} onClick={() => { const r = routeForParam(n.link); if (r) nav(r); }} style={{ alignItems: "flex-start" }}>
              <span aria-hidden>{n.read ? "·" : "●"}</span>
              <div className="grow"><div style={{ fontWeight: n.read ? 500 : 700 }}>{n.title}</div>{n.body && <div className="small muted">{n.body}</div>}<div className="tiny dim mt8">{relTime(n.created_at)}</div></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
