import { Link } from "react-router-dom";
import { Download, ArrowRight } from "lucide-react";
import { Container, Section, Button, button } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { useDownload } from "@/components/download/DownloadProvider";
import {
  CONTACT_EMAIL,
  LegalIntro,
  LegalSections,
  MailLink,
  type LegalSection,
} from "@/components/legal/LegalDoc";

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
  `This Data Processing Addendum (“DPA”) forms part of, and is subject to, the BlissWork Terms of Service (the “Agreement”) between AEIV Global Private Limited (“AEIV Global”, “we”, “us”, the “Processor”) and the customer organisation that has entered into the Agreement (“Customer”, “you”, the “Controller”). It applies to the extent AEIV Global processes Personal Data on behalf of the Customer in providing BlissWork (the “Service”), and reflects the parties’ agreement on such processing under applicable data protection laws, including the EU and UK GDPR and India’s Digital Personal Data Protection Act, 2023 (“Applicable Data Protection Law”).`,
  `If you are a business customer and require a countersigned copy, contact us at ${CONTACT_EMAIL}.`,
];

const SECTIONS: LegalSection[] = [
  {
    n: 1,
    title: "Definitions",
    body: [
      {
        type: "p",
        text: `Capitalised terms not defined here have the meaning given in the Agreement. “Controller”, “Processor”, “Data Subject”, “Personal Data”, “Processing”, and “Personal Data Breach” have the meanings given in Applicable Data Protection Law. “Sub-processor” means any third party engaged by AEIV Global to process Personal Data. “Customer Personal Data” means Personal Data contained in Your Content that AEIV Global processes on the Customer’s behalf.`,
      },
    ],
  },
  {
    n: 2,
    title: "Roles and scope",
    body: [
      {
        type: "node",
        node: (
          <p className="text-[15px] leading-relaxed text-muted">
            For Customer Personal Data, the Customer is the Controller and AEIV Global is the Processor.
            Where the Customer is itself a processor for another controller, AEIV Global acts as a
            sub-processor. Each party will comply with its obligations under Applicable Data Protection
            Law. This DPA does not apply to data for which AEIV Global is an independent controller (such
            as account-registration and billing data), which is governed by our{" "}
            <DocLink to="/privacy">Privacy Policy</DocLink>.
          </p>
        ),
      },
    ],
  },
  {
    n: 3,
    title: "Processing on documented instructions",
    body: [
      {
        type: "p",
        text: `AEIV Global will process Customer Personal Data only on the Customer’s documented instructions — including as set out in this DPA, the Agreement, and the Customer’s configuration and use of the Service — and as required by law (in which case we will inform the Customer unless legally prohibited). The subject matter, nature, purpose, duration, types of Personal Data, and categories of Data Subjects are described in Annex I. The Customer is responsible for ensuring it has a lawful basis to provide the Customer Personal Data and for the accuracy of its instructions.`,
      },
    ],
  },
  {
    n: 4,
    title: "Confidentiality",
    body: [
      {
        type: "p",
        text: `AEIV Global ensures that personnel authorised to process Customer Personal Data are bound by appropriate obligations of confidentiality and access it only on a need-to-know basis.`,
      },
    ],
  },
  {
    n: 5,
    title: "Security",
    body: [
      {
        type: "p",
        text: `AEIV Global implements and maintains appropriate technical and organisational measures to protect Customer Personal Data against accidental or unlawful destruction, loss, alteration, unauthorised disclosure, or access, as described in Annex II. AEIV Global may update these measures provided the level of protection is not materially reduced.`,
      },
    ],
  },
  {
    n: 6,
    title: "Sub-processors",
    body: [
      {
        type: "p",
        text: `The Customer grants AEIV Global general authorisation to engage Sub-processors to provide the Service. A current list of Sub-processors is set out in Annex III. AEIV Global imposes data protection obligations on each Sub-processor that are no less protective than those in this DPA, and remains responsible for their performance. We will give the Customer reasonable prior notice of the addition or replacement of a Sub-processor and, where the Customer has a reasonable, data-protection-based objection, the parties will work in good faith to resolve it.`,
      },
    ],
  },
  {
    n: 7,
    title: "Data subject requests",
    body: [
      {
        type: "p",
        text: `Taking into account the nature of the Processing, AEIV Global will assist the Customer by appropriate technical and organisational measures, insofar as possible, to respond to requests from Data Subjects exercising their rights. If AEIV Global receives such a request directly, it will, where permitted, direct the Data Subject to the Customer.`,
      },
    ],
  },
  {
    n: 8,
    title: "Personal data breach",
    body: [
      {
        type: "p",
        text: `AEIV Global will notify the Customer without undue delay after becoming aware of a Personal Data Breach affecting Customer Personal Data, and will provide information reasonably available to assist the Customer in meeting its breach-notification and cooperation obligations.`,
      },
    ],
  },
  {
    n: 9,
    title: "Impact assessments and consultation",
    body: [
      {
        type: "p",
        text: `AEIV Global will provide reasonable assistance to the Customer with data protection impact assessments and prior consultations with supervisory authorities, taking into account the nature of the Processing and the information available to AEIV Global.`,
      },
    ],
  },
  {
    n: 10,
    title: "International transfers",
    body: [
      {
        type: "p",
        text: `AEIV Global and its Sub-processors may process Customer Personal Data in countries other than the Customer’s own. Where such transfers are subject to Applicable Data Protection Law, the parties rely on an appropriate transfer mechanism — such as the Standard Contractual Clauses (and, for the UK, the UK International Data Transfer Addendum) or an adequacy decision — which are incorporated by reference where applicable.`,
      },
    ],
  },
  {
    n: 11,
    title: "Deletion and return",
    body: [
      {
        type: "p",
        text: `On termination of the Agreement, or on the Customer’s request, AEIV Global will delete or return Customer Personal Data and delete existing copies, except to the extent retention is required by law. Deletion of an Organisation triggers crypto-shredding of its encryption keys, rendering its data permanently unreadable; residual backup copies are purged on our routine rotation cycle.`,
      },
    ],
  },
  {
    n: 12,
    title: "Audits",
    body: [
      {
        type: "p",
        text: `AEIV Global will make available to the Customer information reasonably necessary to demonstrate compliance with this DPA and will allow for and contribute to audits, including inspections, conducted by the Customer or an auditor it mandates, subject to reasonable notice, confidentiality, frequency, and security requirements. Where practicable, AEIV Global may satisfy audit requests by providing relevant documentation or third-party reports.`,
      },
    ],
  },
  {
    n: 13,
    title: "Liability",
    body: [
      {
        type: "p",
        text: `Each party’s liability under or in connection with this DPA is subject to the limitations and exclusions of liability set out in the Agreement.`,
      },
    ],
  },
  {
    n: 14,
    title: "Term",
    body: [
      {
        type: "p",
        text: `This DPA takes effect when the Customer accepts the Agreement and continues until AEIV Global has ceased processing Customer Personal Data and completed deletion or return under Section 11.`,
      },
    ],
  },
  {
    n: 15,
    title: "Governing law",
    body: [
      {
        type: "p",
        text: `This DPA is governed by the law and subject to the dispute-resolution and jurisdiction provisions of the Agreement, except where Applicable Data Protection Law requires otherwise.`,
      },
    ],
  },
  {
    n: 16,
    title: "Order of precedence",
    body: [
      {
        type: "p",
        text: `In the event of a conflict between this DPA and the Agreement regarding the processing of Customer Personal Data, this DPA prevails. In the event of a conflict between this DPA and the Standard Contractual Clauses, the Standard Contractual Clauses prevail.`,
      },
    ],
  },
  {
    n: 17,
    title: "Details of processing (Annex I)",
    body: [
      {
        type: "ul",
        items: [
          `Subject matter: AEIV Global’s provision of the BlissWork Service to the Customer.`,
          `Duration: the term of the Agreement and until deletion or return of Customer Personal Data.`,
          `Nature and purpose: hosting, storage, transmission, encryption, and display of Customer Personal Data to provide team-collaboration features (channels, messaging, presence, invitations) and to secure and support the Service.`,
          `Types of Personal Data: names and display names, usernames, email addresses, message and file content, presence and activity data, and related metadata submitted through the Service.`,
          `Categories of Data Subjects: the Customer’s authorised users and administrators, and the people they invite or communicate with.`,
        ],
      },
    ],
  },
  {
    n: 18,
    title: "Technical and organisational measures (Annex II)",
    body: [
      {
        type: "ul",
        items: [
          `Encryption at rest: sensitive fields (email addresses, display names, message content) encrypted with AES-256-GCM, keyed per organisation.`,
          `Encryption in transit: TLS for all client and inter-service traffic; verified TLS for database connections.`,
          `Password protection: Argon2id hashing; plaintext passwords are never stored.`,
          `Tenant isolation: database row-level security isolating each organisation’s data.`,
          `Access control: least-privilege, authenticated internal service access; limited and logged production access.`,
          `Auditability: tamper-evident, hash-chained audit logs of account and administrative actions.`,
          `Deletion: crypto-shredding of encryption keys on organisation deletion, and routine purging of backups.`,
          `Resilience: encrypted backups and continuous monitoring of the platform.`,
        ],
      },
    ],
  },
  {
    n: 19,
    title: "Sub-processors (Annex III)",
    body: [
      {
        type: "ul",
        items: [
          `Cloud hosting / infrastructure provider — hosting and storage of Service data.`,
          `Transactional email provider — delivery of invitation and account emails.`,
          `Payment processor (for paid plans) — processing of subscription payments.`,
        ],
      },
      { type: "p", text: `A current, more detailed list is available from AEIV Global on request.` },
    ],
  },
  {
    n: 20,
    title: "Contact",
    body: [
      {
        type: "node",
        node: (
          <div className="space-y-2 text-[15px] leading-relaxed text-muted">
            <p className="font-semibold text-fg">AEIV Global Private Limited</p>
            <p>Registered office: 24 B Layout, Bezonbagh, Nagpur, Maharashtra, India, 440014</p>
            <p>
              Data protection contact: <MailLink />
            </p>
            <p>Grievance Officers: Mr. Siddhant Shende and Mr. Nitish Goyal</p>
          </div>
        ),
      },
    ],
  },
];

export default function DPA() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="Legal"
        title={
          <>
            Data Processing <span className="text-gradient">Addendum</span>
          </>
        }
        lead="For business customers: how AEIV Global processes personal data on your behalf as your processor, with the safeguards enterprise teams expect."
      />

      <Section>
        <Container className="max-w-3xl">
          <Reveal>
            <p className="text-sm text-muted">
              Version 1.0 · Last updated: <span className="font-medium text-fg">{LAST_UPDATED}</span> ·
              For business customers
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
              Enterprise-ready, by default
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base text-muted">
              Encryption, isolation, and processor commitments your compliance team can rely on.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/security" className={button({ size: "xl", variant: "secondary" })}>
                See our security
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
