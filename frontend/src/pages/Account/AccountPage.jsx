import React from "react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { canManageTeam } from "../../lib/roles";
import { SectionTitle } from "../../components/ui";
import ProfilePanel from "./ProfilePanel";
import TeamPanel from "./TeamPanel";

/* ---------------------------------------------------------------
   MY ACCOUNT — reached from the avatar menu in the header.
   Profile + change password for everyone; the Team tab (add people,
   reset passwords, change roles, deactivate) for admins and owners.
----------------------------------------------------------------*/
function AccountPage({ user, tab = "profile", onTabChange }) {
  const { t } = useLang();
  const showTeam = canManageTeam(user?.role);
  const active = tab === "team" && showTeam ? "team" : "profile"; // never land on a tab you can't use

  const tabs = [
    { id: "profile", label: t("account.tab.profile") },
    ...(showTeam ? [{ id: "team", label: t("account.tab.team") }] : []),
  ];

  return (
    <div className="max-w-3xl">
      <SectionTitle eyebrow={user?.orgName} title={t("account.title")} desc={t("account.subtitle")} />

      <div role="tablist" className="flex gap-6 mb-6" style={{ borderBottom: `1px solid ${C.greyBorder}` }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={active === tb.id}
            onClick={() => onTabChange?.(tb.id)}
            className="pb-3 text-sm font-medium -mb-px"
            style={{ color: active === tb.id ? C.blue : C.textSecondary, borderBottom: `2px solid ${active === tb.id ? C.blue : "transparent"}` }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {active === "team" ? <TeamPanel user={user} /> : <ProfilePanel user={user} />}
    </div>
  );
}

export default AccountPage;
