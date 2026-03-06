export const COLORS = {
  WHITE: "#FFFFFF",
  BLUE_FRAME: "#2D2DFF",
  BLUE_CONTENT: "#3333E0",
  BLUE_UNDERLINE: "#1F1FD6",
  GREY_LIGHT: "#989999",
  GREY_NEUTRAL: "#878787",
  GREY_DARK: "#4E4D4D",
  RED: "#F00000",
} as const;

export const ROLE_OPTIONS = [
  { label: "ANSWERER & JUDGE — both", display: "ANSWERER & JUDGE", value: "ANSWERER_AND_JUDGE" },
  { label: "JUDGE — only judge challenges", display: "JUDGE", value: "JUDGE" },
  { label: "ANSWERER — only answer queries", display: "ANSWERER", value: "ANSWERER" },
];
