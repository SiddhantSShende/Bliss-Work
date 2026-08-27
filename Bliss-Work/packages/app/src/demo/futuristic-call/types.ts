export type ParticipantDemo = {
  id: string;
  name: string;
  micOn: boolean;
  /** Tailwind gradient classes standing in for a real video track. */
  gradient: string;
};

export type ChatMessageDemo = {
  id: string;
  from: string;
  mine?: boolean;
  at: number;
  text: string;
};
