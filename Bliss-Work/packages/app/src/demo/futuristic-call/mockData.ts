import type { ChatMessageDemo, ParticipantDemo } from "./types";

export const MOCK_PARTICIPANTS: [ParticipantDemo, ...ParticipantDemo[]] = [
  { id: "p1", name: "Aria Patel", micOn: true, gradient: "bg-gradient-to-br from-cyan-500/40 to-blue-950" },
  { id: "p2", name: "Kenji Oda", micOn: false, gradient: "bg-gradient-to-br from-fuchsia-500/40 to-purple-950" },
  { id: "p3", name: "Maya Chen", micOn: true, gradient: "bg-gradient-to-br from-emerald-500/40 to-teal-950" },
  { id: "p4", name: "Diego Santos", micOn: true, gradient: "bg-gradient-to-br from-amber-500/40 to-orange-950" },
  { id: "p5", name: "Layla Nasser", micOn: false, gradient: "bg-gradient-to-br from-rose-500/40 to-red-950" },
];

export const MOCK_MESSAGES: ChatMessageDemo[] = [
  { id: "m1", from: "Kenji Oda", at: Date.now() - 1000 * 60 * 6, text: "Can everyone see the roadmap slide okay?" },
  { id: "m2", from: "Maya Chen", at: Date.now() - 1000 * 60 * 4, text: "Yep, looks good on my end." },
  { id: "m3", from: "You", mine: true, at: Date.now() - 1000 * 60 * 2, text: "Great — moving to Q3 milestones next." },
];
