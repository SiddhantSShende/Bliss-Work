import { Link } from "react-router-dom";
import { Download, ArrowRight } from "lucide-react";
import { Container, Section, Button, button } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { useDownload } from "@/components/download/DownloadProvider";
import { LegalIntro, LegalSections, MailLink, type LegalSection } from "@/components/legal/LegalDoc";

const LAST_UPDATED = "3 July 2026";

const DocLink = ({ to, children }: { to: string; children: React.ReactNode }) => (
  <Link
    to={to}
    className="font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent"
  >
    {children}
  </Link>
);

const INTRO: string[] = [
  `These Terms of Service (“Terms”) are a binding agreement between you and AEIV Global Private Limited, a company incorporated in India (“AEIV Global”, “we”, “us”, or “our”), and govern your access to and use of BlissWork — our team collaboration platform, including its web application and desktop application distributed through the Microsoft Store (the “Service”).`,
  `Please read these Terms carefully. By creating an account, accessing, or using the Service, you agree to be bound by these Terms and by our Privacy Policy. If you do not agree, do not use the Service.`,
];

const SECTIONS: LegalSection[] = [
  {
    n: 1,
    title: "Who may use the Service",
    body: [
      {
        type: "p",
        text: `You must be at least 18 years old to use the Service. If you use the Service on behalf of an organisation (your “Organisation”), you represent that you are authorised to accept these Terms on its behalf, and “you” refers to both you and that Organisation. The Service is intended for business and professional use.`,
      },
    ],
  },
  {
    n: 2,
    title: "The Service",
    body: [
      {
        type: "p",
        text: `BlissWork provides a private communication network for teams — channels, direct messages, an internal inbox, presence, and related collaboration features. We may add, change, or remove features from time to time to improve the Service. We will not materially reduce the core functionality of a paid plan during a paid term without notice.`,
      },
    ],
  },
  {
    n: 3,
    title: "Accounts and organisations",
    body: [
      {
        type: "node",
        node: (
          <p className="text-[15px] leading-relaxed text-muted">
            To use the Service you must create an account with accurate information and keep it up to
            date. You are responsible for safeguarding your login credentials and for all activity that
            occurs under your account. Notify us promptly at <MailLink /> if you suspect unauthorised
            use.
          </p>
        ),
      },
      {
        type: "p",
        text: `An Organisation’s administrators control that Organisation’s workspace, including its members, roles, content, and settings. If you join a workspace created by your employer or another party, that party administers your use of the Service within the workspace and may access, restrict, or remove your access and content within it.`,
      },
    ],
  },
  {
    n: 4,
    title: "Subscriptions, fees, and payment",
    body: [
      { type: "p", text: `The Service may be offered on free and paid subscription plans. For paid plans:` },
      {
        type: "ul",
        items: [
          `Fees, billing frequency, and features are as described at the point of purchase. Unless stated otherwise, subscriptions renew automatically for successive terms until cancelled.`,
          `Payments are processed either through the Microsoft Store (where Microsoft is the merchant of record) or through our third-party payment processor. Your purchase is also subject to that provider’s terms.`,
          `Fees are exclusive of taxes; you are responsible for applicable taxes, levies, or duties, except taxes on our income.`,
          `We may change our fees on reasonable prior notice, effective at the start of your next billing term.`,
          `Except where required by law or the platform’s rules, fees are non-refundable. Where the Microsoft Store processes your purchase, refunds and cancellations are handled under Microsoft’s policies.`,
        ],
      },
      {
        type: "p",
        text: `You may cancel a subscription at any time; cancellation takes effect at the end of the current billing term.`,
      },
    ],
  },
  {
    n: 5,
    title: "Your content and ownership",
    body: [
      {
        type: "p",
        text: `“Your Content” means the messages, files, and other material you or your Organisation submit to the Service. As between you and us, you and your Organisation own Your Content. Within a workspace, Your Content belongs to and is controlled by the Organisation that owns that workspace.`,
      },
      {
        type: "p",
        text: `You grant us a limited, worldwide, non-exclusive licence to host, store, transmit, encrypt, display, and process Your Content solely as necessary to operate, secure, and provide the Service to you and your Organisation. We claim no ownership of Your Content and do not use it for advertising, and we do not use it to train artificial intelligence or machine-learning models.`,
      },
    ],
  },
  {
    n: 6,
    title: "Acceptable use",
    body: [
      { type: "p", text: `You agree not to, and not to permit any user to:` },
      {
        type: "ul",
        items: [
          `Use the Service for any unlawful, fraudulent, harmful, or abusive purpose;`,
          `Upload or transmit malware, or attempt to gain unauthorised access to, probe, or disrupt the Service, its infrastructure, or other users’ data;`,
          `Send spam, chain messages, or unsolicited bulk invitations, or harvest users’ contact information;`,
          `Post or share content that is unlawful, infringing, defamatory, obscene, harassing, hateful, or that violates the rights or privacy of others;`,
          `Reverse engineer, decompile, scrape, or attempt to derive source code, except to the extent this restriction is prohibited by applicable law;`,
          `Resell, sublicense, or provide the Service to third parties except as expressly permitted;`,
          `Circumvent usage limits, security controls, or authentication, or use the Service to build a competing product.`,
        ],
      },
      {
        type: "p",
        text: `We may apply reasonable rate limits and technical safeguards, and we may investigate suspected violations.`,
      },
    ],
  },
  {
    n: 7,
    title: "Responsibility for content and conduct",
    body: [
      {
        type: "p",
        text: `You are solely responsible for Your Content and for your and your users’ conduct on the Service. You represent that you have all rights necessary to submit Your Content and that it does not violate these Terms or any law. We do not routinely monitor content, but we may remove or disable access to content or suspend accounts that we reasonably believe violate these Terms or applicable law.`,
      },
    ],
  },
  {
    n: 8,
    title: "Spam, abuse, and fair use",
    body: [
      {
        type: "p",
        text: `The invitation and messaging features are provided for genuine team collaboration. Using them to send unsolicited, deceptive, or bulk communications is prohibited and may result in throttling, feature restrictions, or suspension. You are responsible for ensuring you have a lawful basis to invite the people you invite.`,
      },
    ],
  },
  {
    n: 9,
    title: "Intellectual property",
    body: [
      {
        type: "p",
        text: `The Service, including its software, design, and the BlissWork name and logo, is owned by AEIV Global and its licensors and is protected by intellectual property laws. Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, revocable licence to use the Service for your internal business purposes. All rights not expressly granted are reserved. If you send us feedback or suggestions, you grant us a perpetual, royalty-free licence to use them without obligation to you.`,
      },
    ],
  },
  {
    n: 10,
    title: "Third-party services",
    body: [
      {
        type: "p",
        text: `The Service relies on and may interoperate with third-party services (such as the Microsoft Store, hosting infrastructure, and an email-delivery provider). Your use of those services may be subject to their own terms and privacy policies, and we are not responsible for third-party services.`,
      },
    ],
  },
  {
    n: 11,
    title: "Privacy and data protection",
    body: [
      {
        type: "node",
        node: (
          <p className="text-[15px] leading-relaxed text-muted">
            Our handling of personal information is described in our{" "}
            <DocLink to="/privacy">Privacy Policy</DocLink>, which is incorporated into these Terms.
            Where we process personal data on behalf of your Organisation as a processor, our{" "}
            <DocLink to="/dpa">Data Processing Addendum (DPA)</DocLink> applies and is available to
            business customers on request or on our website.
          </p>
        ),
      },
    ],
  },
  {
    n: 12,
    title: "Suspension and termination",
    body: [
      {
        type: "p",
        text: `You may stop using the Service and delete your account or Organisation at any time. We may suspend or terminate your access, with or without notice, if you breach these Terms, if required by law, or to protect the Service or its users.`,
      },
      {
        type: "p",
        text: `On termination: your right to use the Service ends, and Your Content is deleted in accordance with our Privacy Policy (including crypto-shredding of an Organisation’s data on deletion), subject to limited records we must retain by law. Sections that by their nature should survive termination (including Sections 5, 9, 13, 14, 15, 17, and 18) will survive.`,
      },
    ],
  },
  {
    n: 13,
    title: "Disclaimer of warranties",
    body: [
      {
        type: "p",
        text: `The Service is provided “AS IS” and “AS AVAILABLE”, without warranties of any kind, whether express, implied, or statutory, including implied warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or completely secure. Some jurisdictions do not allow the exclusion of certain warranties, so some of the above may not apply to you.`,
      },
    ],
  },
  {
    n: 14,
    title: "Limitation of liability",
    body: [
      {
        type: "p",
        text: `To the maximum extent permitted by law, AEIV Global and its officers, employees, and suppliers will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, revenue, data, goodwill, or business, arising out of or relating to the Service, even if advised of the possibility.`,
      },
      {
        type: "p",
        text: `To the maximum extent permitted by law, our total aggregate liability arising out of or relating to the Service or these Terms will not exceed the greater of (a) the amounts you paid us for the Service in the twelve (12) months before the event giving rise to the claim, or (b) INR 5,000. Nothing in these Terms excludes liability that cannot be excluded under applicable law.`,
      },
    ],
  },
  {
    n: 15,
    title: "Indemnification",
    body: [
      {
        type: "p",
        text: `You agree to indemnify and hold harmless AEIV Global and its personnel from and against any claims, damages, liabilities, and reasonable expenses (including legal fees) arising out of or related to Your Content, your use of the Service, or your breach of these Terms or of any law or third-party right.`,
      },
    ],
  },
  {
    n: 16,
    title: "Export controls and sanctions",
    body: [
      {
        type: "p",
        text: `You must comply with all applicable export control and economic sanctions laws. You represent that you are not located in, and will not use the Service in or for the benefit of, any country or party subject to comprehensive sanctions or embargoes, and that you are not on any restricted-party list.`,
      },
    ],
  },
  {
    n: 17,
    title: "Governing law and dispute resolution",
    body: [
      {
        type: "p",
        text: `These Terms are governed by the laws of India, without regard to conflict-of-law rules. Subject to the paragraph below, the courts at Nagpur, Maharashtra, India will have exclusive jurisdiction over any dispute arising out of or relating to these Terms or the Service.`,
      },
      {
        type: "p",
        text: `The parties will first attempt to resolve any dispute amicably. If unresolved within thirty (30) days, the dispute may be referred to arbitration by a sole arbitrator under the Arbitration and Conciliation Act, 1996; the seat and venue of arbitration will be Nagpur, India, and the proceedings will be conducted in English.`,
      },
    ],
  },
  {
    n: 18,
    title: "Copyright and content complaints",
    body: [
      {
        type: "p",
        text: `We respect intellectual property rights. If you believe content on the Service infringes your copyright or other rights, or is otherwise unlawful, send a written notice to our Grievance Officer (Section 20) with: your contact details; identification of the work and the allegedly infringing material; a statement of your good-faith belief; and your electronic or physical signature. We will respond and act on valid notices as required by applicable law, including the Information Technology Act, 2000 and the rules thereunder, and may remove content or disable access.`,
      },
    ],
  },
  {
    n: 19,
    title: "Changes to the Service or these Terms",
    body: [
      {
        type: "p",
        text: `We may modify these Terms from time to time. We will update the “Last updated” date above and, for material changes, provide reasonable notice (for example, by email or in-app notice). Changes take effect when posted unless stated otherwise. Your continued use of the Service after changes take effect constitutes acceptance of the revised Terms.`,
      },
    ],
  },
  {
    n: 20,
    title: "General and contact",
    body: [
      {
        type: "p",
        text: `These Terms, together with the Privacy Policy and any DPA, are the entire agreement between you and us regarding the Service and supersede prior agreements. If any provision is held unenforceable, the remaining provisions remain in effect. Our failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a merger, acquisition, or sale of assets. We are not liable for delays or failures caused by events beyond our reasonable control (force majeure). Notices to you may be given by email or in-app; notices to us should be sent to the address below.`,
      },
      {
        type: "node",
        node: (
          <div className="space-y-4 text-[15px] leading-relaxed text-muted">
            <div>
              <p className="font-semibold text-fg">AEIV Global Private Limited</p>
              <p>Registered office: 24 B Layout, Bezonbagh, Nagpur, Maharashtra, India, 440014</p>
              <p>
                General enquiries: <MailLink />
              </p>
            </div>
            <div>
              <p className="font-semibold text-fg">Grievance Officers</p>
              <p className="text-sm text-muted/80">(as required under Indian law)</p>
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
];

export default function Terms() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title={
          <>
            Terms of <span className="text-gradient">Service</span>
          </>
        }
        lead="The agreement between you and AEIV Global Private Limited for using BlissWork — what you can expect from us, and what we ask of you."
      />

      <Section>
        <Container className="max-w-3xl">
          <Reveal>
            <p className="text-sm text-muted">
              Version 1.0 · Last updated: <span className="font-medium text-fg">{LAST_UPDATED}</span> ·
              Governed by the laws of India
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
              Ready when your team is
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base text-muted">
              Bring BlissWork to your team — private by design, encrypted by default.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/privacy" className={button({ size: "xl", variant: "secondary" })}>
                Read the Privacy Policy
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
