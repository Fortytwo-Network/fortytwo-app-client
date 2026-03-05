import { useState, useEffect } from "react";
import { Text } from "ink";

const FRAMES = [
  "∷", "◯", "□", "‖", "∷", "∷", "‖", "□", "■", "■",
  "□", "◯", "‖", "∷", "∷", "‖", "□", "■", "■", "□",
  "◯", "‖", "∷", "∷", "‖", "□", "◯", "●", "●",
];

export function useLoader(isActive: boolean): string {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setIdx((i) => (i + 1) % FRAMES.length), 100);
    return () => clearInterval(timer);
  }, [isActive]);
  return FRAMES[idx];
}

interface LoaderProps {
  color?: string;
}

export default function Loader({ color = "yellow" }: LoaderProps) {
  const frame = useLoader(true);
  return <Text color={color}>{frame}</Text>;
}
