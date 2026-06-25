import { useState } from "react";
import { Check, Eye, EyeOff, X } from "lucide-react";
import { Input } from "@taskboard/ui";
import { checkPassword, passwordStrength } from "../lib/password";

const BAR = ["bg-danger", "bg-danger", "bg-warning", "bg-accent", "bg-success"];

/** Password input with a live strength meter and the enforced requirements. */
export function PasswordField({
  value,
  onChange,
  show: showRequirements = true,
}: {
  value: string;
  onChange: (v: string) => void;
  show?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const check = checkPassword(value);
  const { score, label } = passwordStrength(value);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="••••••••"
          className="pr-10"
          required
          minLength={8}
          aria-invalid={value.length > 0 && !check.ok}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-fg"
          title={reveal ? "Hide password" : "Show password"}
        >
          {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>

      {value.length > 0 && (
        <>
          <div className="flex items-center gap-2">
            <div className="flex h-1.5 flex-1 gap-1">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`flex-1 rounded-full transition-colors ${
                    i < score ? BAR[score] : "bg-border"
                  }`}
                />
              ))}
            </div>
            <span className="w-14 text-right text-[11px] font-medium text-muted">{label}</span>
          </div>

          {showRequirements && (
            <ul className="flex flex-col gap-0.5 text-[12px]">
              <Req ok={check.minLen}>At least 8 characters</Req>
              <Req ok={check.special}>One special character (!@#$…)</Req>
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Req({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? "text-success" : "text-muted"}`}>
      {ok ? <Check size={13} /> : <X size={13} />}
      {children}
    </li>
  );
}
