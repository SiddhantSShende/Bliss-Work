import { useTranslation } from "react-i18next";
import { Badge } from "@taskboard/ui";

/** Admin/Member, in the one badge shape used for a role everywhere it's shown. */
export function RoleBadge({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  const { t } = useTranslation("shell");
  return (
    <Badge tone={isAdmin ? "accent" : "neutral"} className={className}>
      {isAdmin ? t("roleBadge.admin") : t("roleBadge.member")}
    </Badge>
  );
}
