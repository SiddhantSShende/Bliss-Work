import { Link } from "react-router-dom";
import { Download, ArrowRight } from "lucide-react";
import { Container, Section, Button, button } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { useDownload } from "@/components/download/DownloadProvider";
import {
  LegalIntro,
  LegalSections,
  MailLink,
  type LegalSection,
} from "@/components/legal/LegalDoc";

const LAST_UPDATED = "3 July 2026";

const INTRO: string[] = [
  `BlissWork is offered internationally. This Privacy Policy applies to all users of the Service worldwide, regardless of the country from which you access it, and explains how AEIV Global Private Limited (“AEIV Global”, “we”, “us”, or “our”), a company incorporated in India, collects, uses, discloses, and protects your personal information when you use BlissWork — our team collaboration platform, including its web application and desktop application distributed through the Microsoft Store (the “Service”).`,
  `By creating an account or using the Service, you agree to the practices described in this Policy. If you do not agree, please do not use the Service.`,
];

const SECTIONS: LegalSection[] = [
  {
    n: 1,
    title: "Who we are and our role",
    body: [
      {
        type: "p",
        text: `AEIV Global is the operator of BlissWork. For personal information relating to your account registration, billing, and communications with us, AEIV Global acts as the data controller (or “Data Fiduciary” under India’s Digital Personal Data Protection Act, 2023).`,
      },
      {
        type: "p",
        text: `For content you and your colleagues create inside a workspace (such as messages), the organisation that owns the workspace is the controller, and AEIV Global acts as a data processor on that organisation’s behalf, processing such data only per our agreement with them. Business customers may request a Data Processing Addendum (DPA) by contacting us.`,
      },
    ],
  },
  {
    n: 2,
    title: "Information we collect",
    body: [
      { type: "p", text: `We collect only the information needed to provide a secure collaboration service:` },
      {
        type: "group",
        heading: "a) Account and profile information",
        items: [
          `Your name and display name`,
          `Username and email address`,
          `A securely hashed version of your password (using the Argon2id algorithm — we never store or have access to your plaintext password)`,
        ],
      },
      {
        type: "group",
        heading: "b) Organisation information",
        items: [
          `Organisation name and identifier`,
          `Your role within the organisation (e.g. administrator or member) and your workspace memberships`,
        ],
      },
      {
        type: "group",
        heading: "c) Invitations",
        items: [
          `When you invite a colleague, we process the invitee’s email address and assigned role to deliver the invitation. You confirm that you have a proper basis to share that person’s email address with us.`,
        ],
      },
      {
        type: "group",
        heading: "d) Content and activity data",
        items: [
          `Messages you send, conversation membership, and read receipts, so your team’s conversations synchronise across devices`,
        ],
      },
      {
        type: "group",
        heading: "e) Presence data",
        items: [`Real-time online/connection status, so colleagues can see who is currently active`],
      },
      {
        type: "group",
        heading: "f) Authentication and session data",
        items: [
          `A single essential authentication cookie named “refresh_token”, set as HttpOnly, Secure, and SameSite, used solely to keep you signed in. We do not use advertising, marketing, or third-party analytics cookies.`,
          `Short-lived access tokens used to authenticate your requests`,
        ],
      },
      {
        type: "group",
        heading: "g) Security and audit logs",
        items: [
          `Records of account and administrative actions (who did what, and when), maintained in a tamper-evident form for security and accountability`,
        ],
      },
      {
        type: "group",
        heading: "h) Technical and log data",
        items: [
          `Standard server logs including IP address, browser/device type, and timestamps, generated automatically when you use the Service and used for security, diagnostics, and reliability`,
        ],
      },
      {
        type: "group",
        heading: "i) Payment information (for paid subscriptions)",
        items: [`See Section 6. We do not store your full payment card details on our servers.`],
      },
      {
        type: "group",
        heading: "j) Support communications",
        items: [`Any information you provide when you contact us for support`],
      },
      {
        type: "p",
        text: `We do not collect special categories of sensitive data, and we do not require any information beyond what is necessary to operate the Service.`,
      },
    ],
  },
  {
    n: 3,
    title: "How we use your information and legal bases",
    body: [
      { type: "p", text: `We use your information to:` },
      {
        type: "ul",
        items: [
          `Provide, maintain, and secure the Service (authenticating you, delivering messages and invitations, showing presence, syncing your data)`,
          `Maintain audit trails and prevent fraud, abuse, and unauthorised access`,
          `Provide customer support and respond to your requests`,
          `Send essential service communications (e.g. security, account, and transactional notices)`,
          `Comply with legal obligations and enforce our terms`,
          `Process payments and manage subscriptions (where applicable)`,
          `Improve the reliability and performance of the Service`,
        ],
      },
      {
        type: "p",
        text: `Where the GDPR / UK GDPR applies, our legal bases are: performance of a contract (to provide the Service), legitimate interests (to secure and improve the Service and prevent abuse), consent (where required, which you may withdraw at any time), and compliance with a legal obligation. Under India’s DPDP Act, we process personal data based on your consent or for legitimate uses as permitted by law.`,
      },
      {
        type: "p",
        text: `We do not sell your personal information, and we do not use it for advertising or cross-context behavioural profiling.`,
      },
      {
        type: "p",
        text: `We do not use your messages, files, or other business content to train artificial intelligence or machine-learning models. If we introduce AI-powered features in the future, we will update this Policy and, where required, obtain your consent before doing so.`,
      },
    ],
  },
  {
    n: 4,
    title: "Cookies",
    body: [
      {
        type: "p",
        text: `BlissWork uses a single essential authentication cookie (“refresh_token”) to keep you securely signed in. Because it is strictly necessary to the Service, it does not require consent under applicable law. We do not use analytics, advertising, or social-media tracking cookies.`,
      },
    ],
  },
  {
    n: 5,
    title: "How we share information",
    body: [
      { type: "p", text: `We share personal information only in these limited circumstances:` },
      {
        type: "ul",
        items: [
          `Within your organisation: your display name, presence, messages, and activity are visible to other members of your workspace, as inherent to a collaboration tool.`,
          `Service providers (processors): we use trusted third parties who process data on our behalf under contract, including a transactional email provider (to deliver invitation and account emails), our cloud hosting/infrastructure provider, and — for paid plans — a payment processor. These providers are bound to use your data only as we instruct.`,
          `Distribution platform: the desktop app is distributed via the Microsoft Store; Microsoft’s own privacy terms govern any data it collects through the store.`,
          `Legal and safety: where required by law, court order, or to protect the rights, safety, and security of our users, the public, or AEIV Global.`,
          `Business transfers: in connection with a merger, acquisition, or sale of assets, subject to this Policy.`,
        ],
      },
      {
        type: "p",
        text: `We do not sell or rent your personal information to data brokers, advertisers, or any third party for their own marketing.`,
      },
      {
        type: "p",
        text: `Law enforcement and legal requests: we do not voluntarily hand your data to governments. We disclose personal information to law enforcement or other authorities only when compelled by valid legal process (such as a binding court order or subpoena), or where strictly necessary to protect the rights, safety, and security of our users, the public, or AEIV Global. Where we are legally permitted to do so, we will notify the affected organisation before disclosing.`,
      },
    ],
  },
  {
    n: 6,
    title: "Payments and subscriptions",
    body: [
      {
        type: "p",
        text: `BlissWork may offer paid subscriptions. When it does, payments will be processed either through the Microsoft Store (where Microsoft acts as merchant of record and processes your payment information under its own privacy policy) or through a third-party payment processor (such as Stripe or Paddle). In both cases, payment card processing is handled by the PCI-DSS-compliant provider, and we do not store your full card number on our systems. We retain only limited billing records (such as plan, transaction identifiers, and invoices) required for accounting and legal compliance.`,
      },
    ],
  },
  {
    n: 7,
    title: "International data transfers",
    body: [
      {
        type: "p",
        text: `BlissWork is used around the world, and your information may be processed in, and transferred to, countries other than the one in which you live — including India, where AEIV Global is based, and the regions where our infrastructure providers operate. Your information is processed on secure servers provided by a third-party hosting provider.`,
      },
      {
        type: "p",
        text: `Wherever your personal information is transferred across borders, we apply appropriate safeguards recognised under applicable law to ensure it remains protected, including:`,
      },
      {
        type: "ul",
        items: [
          `Standard Contractual Clauses (SCCs) approved by the European Commission and, for the UK, the UK International Data Transfer Agreement / Addendum;`,
          `Reliance on adequacy decisions where they exist; and`,
          `Equivalent contractual and technical measures where required by your local law.`,
        ],
      },
      { type: "p", text: `You may contact us to request more information about these safeguards.` },
    ],
  },
  {
    n: 8,
    title: "Data retention and deletion",
    body: [
      {
        type: "p",
        text: `We retain your personal information for as long as your account or organisation remains active, and thereafter only as long as necessary to comply with our legal obligations, resolve disputes, and enforce our agreements. When an organisation is deleted, its encryption keys are destroyed (crypto-shredding), rendering its data permanently unreadable. Residual copies in encrypted backups are purged on our routine backup-rotation cycle.`,
      },
      {
        type: "group",
        heading: "How to delete your data",
        items: [
          `Delete your account: you may delete your individual account at any time from your account settings, or by contacting us. This removes your profile and personal details from our active systems.`,
          `Delete a workspace/organisation: an organisation administrator may delete the entire organisation. This permanently destroys the organisation’s encryption keys (crypto-shredding), so its messages and data can no longer be read by anyone, including us.`,
          `Timing: deletions take effect on our active systems promptly, and the data is then removed from encrypted backups as those backups expire on our routine rotation cycle. We retain limited records only where required by law (for example, tax or accounting records).`,
        ],
      },
    ],
  },
  {
    n: 9,
    title: "How we protect your data",
    body: [
      { type: "p", text: `Security is core to BlissWork:` },
      {
        type: "ul",
        items: [
          `Encryption at rest: sensitive fields (including email addresses, display names, and message content) are encrypted using AES-256-GCM, with encryption scoped per organisation.`,
          `Encryption in transit: all data is transmitted over TLS.`,
          `Strict tenant isolation: each organisation’s data is isolated at the database level (row-level security), so one organisation cannot access another’s data.`,
          `Password protection: passwords are hashed with Argon2id and are never stored in plaintext.`,
          `Tamper-evident audit logs and crypto-shredding for verifiable, permanent deletion.`,
        ],
      },
      {
        type: "p",
        text: `No system is perfectly secure, but we maintain administrative, technical, and organisational measures appropriate to the sensitivity of the data.`,
      },
      {
        type: "p",
        text: `Breach notification: if we become aware of a security incident that compromises your personal information, we will notify the affected organisations and users, and the relevant supervisory authorities, without undue delay and as required by applicable law (including the GDPR and India’s DPDP Act, 2023).`,
      },
      {
        type: "node",
        node: (
          <p className="text-[15px] leading-relaxed text-muted">
            Reporting a vulnerability: we welcome responsible disclosure. If you believe you have found
            a security issue, please email <MailLink />. We will acknowledge your report and work with
            you to resolve it, and we ask that you give us a reasonable opportunity to fix the issue
            before disclosing it publicly.
          </p>
        ),
      },
    ],
  },
  {
    n: 10,
    title: "Your rights",
    body: [
      {
        type: "p",
        text: `Wherever you live, you may have some or all of the following rights over your personal information:`,
      },
      {
        type: "ul",
        items: [
          `Access the personal information we hold about you`,
          `Correct inaccurate or incomplete information`,
          `Delete your personal information (“right to erasure”)`,
          `Restrict or object to certain processing`,
          `Data portability — receive your data in a portable format`,
          `Withdraw consent at any time, without affecting prior lawful processing`,
          `Lodge a complaint with your data protection authority`,
        ],
      },
      {
        type: "node",
        node: (
          <p className="text-[15px] leading-relaxed text-muted">
            To exercise any right, contact us at <MailLink />. We will respond within the timeframes
            required by applicable law. We will not discriminate against you for exercising your rights.
          </p>
        ),
      },
    ],
  },
  {
    n: 11,
    title: "Region-specific disclosures",
    body: [
      {
        type: "p",
        text: `Because BlissWork is used internationally, the following region-specific rights apply in addition to the rights above:`,
      },
      {
        type: "sub",
        heading: "India (Digital Personal Data Protection Act, 2023)",
        text: `You are a “Data Principal” and AEIV Global is the “Data Fiduciary”. You have the right to access, correct, and erase your data, to grievance redressal, and to nominate another individual to exercise your rights in the event of death or incapacity. You may address any grievance to our Grievance Officer (Section 13).`,
      },
      {
        type: "sub",
        heading: "European Economic Area & United Kingdom (GDPR / UK GDPR)",
        text: `You have the rights listed in Section 10 and may lodge a complaint with your local supervisory authority. Our legal bases are described in Section 3.`,
      },
      {
        type: "sub",
        heading: "United States — California (CCPA/CPRA) and other state laws",
        text: `In the preceding 12 months we have collected the categories of personal information described in Section 2. We do not sell or share personal information as those terms are defined under the CCPA/CPRA, and we do not use it for cross-context behavioural advertising. You have the rights to know, delete, correct, and opt out, and the right to non-discrimination. Residents of other US states with privacy laws (such as Virginia, Colorado, Connecticut, Utah, and Texas) have comparable rights, which we honour.`,
      },
      {
        type: "sub",
        heading: "Canada (PIPEDA), Brazil (LGPD), Australia (Privacy Act), and other regions",
        text: `Residents of these and other countries may have comparable rights over their personal information, which we honour to the extent required by local law.`,
      },
      {
        type: "sub",
        heading: "Other jurisdictions",
        text: `If your country grants you privacy rights not listed above, contact us and we will honour them as required by applicable law.`,
      },
    ],
  },
  {
    n: 12,
    title: "Children’s privacy",
    body: [
      {
        type: "p",
        text: `BlissWork is a workplace product intended for use by individuals aged 18 and older and is not directed to children. We do not knowingly collect personal information from children. If you believe a child has provided us data, contact us and we will delete it.`,
      },
    ],
  },
  {
    n: 13,
    title: "Contact us",
    body: [
      {
        type: "node",
        node: (
          <div className="space-y-5 text-[15px] leading-relaxed text-muted">
            <div>
              <p className="font-semibold text-fg">AEIV Global Private Limited</p>
              <p>Registered office: 24 B Layout, Bezonbagh, Nagpur, Maharashtra, India, 440014</p>
              <p>
                General &amp; privacy enquiries: <MailLink />
              </p>
              <p>
                Security &amp; vulnerability reports: <MailLink />
              </p>
            </div>
            <div>
              <p className="font-semibold text-fg">Grievance Officers</p>
              <p className="text-sm text-muted/80">(as required under the DPDP Act, 2023)</p>
              <p className="mt-1">Mr. Siddhant Shende and Mr. Nitish Goyal</p>
              <p>
                Email: <MailLink />
              </p>
            </div>
          </div>
        ),
      },
    ],
  },
  {
    n: 14,
    title: "Changes to this Policy",
    body: [
      {
        type: "p",
        text: `We may update this Policy from time to time. We will revise the “Last updated” date above and, for material changes, notify account administrators by email or in-app notice. Your continued use of the Service after an update constitutes acceptance of the revised Policy.`,
      },
    ],
  },
];

export default function Privacy() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title={
          <>
            Privacy <span className="text-gradient">Policy</span>
          </>
        }
        lead="How AEIV Global Private Limited collects, uses, and protects your information across BlissWork — written plainly, and applied the same way for every user, in every country."
      />

      <Section>
        <Container className="max-w-3xl">
          <Reveal>
            <p className="text-sm text-muted">
              Version 1.0 · Last updated: <span className="font-medium text-fg">{LAST_UPDATED}</span> ·
              Applies to BlissWork worldwide
            </p>
          </Reveal>
          <Reveal delay={0.05}>
            <div className="mt-6">
              <LegalIntro paragraphs={INTRO} />
            </div>
          </Reveal>
          <div className="mt-5">
            <LegalSections sections={SECTIONS} />
          </div>
        </Container>
      </Section>

      <Section className="pb-28 pt-0">
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              A workspace your team can trust
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base text-muted">
              Private by design, encrypted by default. Bring BlissWork to your team and feel the
              difference.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/about" className={button({ size: "xl", variant: "secondary" })}>
                About BlissWork
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
