import React from "react";
import { User, Users, LogOut } from "lucide-react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { canManageTeam, initialsOf } from "../lib/roles";
import { Popover, MenuItems, menuKeyDown, Pill } from "./ui";

/* ---------------------------------------------------------------
   USER MENU — the avatar in the header. Used to be a bare "log out"
   button; now it opens who-you-are + the way into the account page
   (profile, password, and — for admins — the team).
----------------------------------------------------------------*/
function UserMenu({ user, onNavigate, onLogout }) {
  const { t } = useLang();
  const items = [
    { key: "account", label: t("user.myAccount"), icon: User, onSelect: () => onNavigate("profile") },
    { key: "team", label: t("user.team"), icon: Users, onSelect: () => onNavigate("team"), hidden: !canManageTeam(user?.role) },
    { key: "logout", label: t("auth.logout"), icon: LogOut, onSelect: onLogout, separatorBefore: true },
  ];
  return (
    <Popover
      label={t("user.menu")}
      role="menu"
      onKeyDown={menuKeyDown}
      panelStyle={{ width: 260 }}
      renderTrigger={({ ref, open, toggle }) => (
        <button
          ref={ref}
          type="button"
          aria-label={t("user.menu")}
          title={user?.name || t("user.menu")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white"
          style={{ background: C.blueDark, boxShadow: open ? `0 0 0 2px ${C.blue}` : "none" }}
        >
          {initialsOf(user?.name)}
        </button>
      )}
    >
      {({ close }) => (
        <div className="py-1.5">
          <div className="px-3 pt-2 pb-3 mb-1.5" style={{ borderBottom: `1px solid ${C.greyBorderSoft}` }}>
            <div className="text-sm font-semibold truncate" style={{ color: C.charcoal }}>{user?.name}</div>
            <div className="text-xs truncate" style={{ color: C.textSecondary }}>{user?.email}</div>
            <div className="flex items-center gap-2 mt-2">
              <Pill tone="blue">{t(`role.${user?.role}`)}</Pill>
              {user?.orgName && <span className="text-xs truncate" style={{ color: C.textMuted }}>{user.orgName}</span>}
            </div>
          </div>
          <MenuItems items={items.filter((i) => !i.hidden)} close={close} />
        </div>
      )}
    </Popover>
  );
}

export default UserMenu;
