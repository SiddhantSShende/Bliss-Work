/** Single source of truth for nav + external links. */
export const SITE = {
  name: "BlissWork",
  tagline: "Your team, in flow.",
  category: "Enterprise communication network",
  description:
    "BlissWork is the private communication network for your enterprise — channels, direct messages, internal mail, and one calm inbox shared only with the people you work with. No strangers, no noise, encrypted by default.",
  /** Publisher — surfaced in the footer and About page. */
  company: "AEIV Global Private Limited",
  /** Hosted web app — opened by the "Operate with Browser" CTA. */
  webApp: "https://communication.rnrtechs.com",
  year: new Date().getFullYear(),
} as const;

export interface NavLink {
  label: string;
  to: string;
}

export const NAV_LINKS: NavLink[] = [
  { label: "Home", to: "/" },
  { label: "Userflow", to: "/userflow" },
  { label: "Architecture", to: "/architect" },
  { label: "About us", to: "/about" },
];

export const LEGAL_LINKS: NavLink[] = [
  { label: "Security", to: "/security" },
  { label: "Privacy Policy", to: "/privacy" },
  { label: "Terms of Service", to: "/terms" },
  { label: "Data Processing (DPA)", to: "/dpa" },
];
