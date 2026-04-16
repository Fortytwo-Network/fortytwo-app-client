import { Box, Text } from "ink";
import { COLORS } from "./constants.js";

export type LogoTier = "challenger" | "capable" | null;

interface LogoMarkProps {
  tier?: LogoTier;
  activeDot?: number;
  height?: number;
}

function dotGlyph(index: number, activeDot: number, tier: LogoTier): string {
  if (index !== activeDot) return "●";
  if (tier === "capable") return "▲";
  return "■";
}

function dotColor(index: number, activeDot: number): string {
  return index === activeDot ? COLORS.BLUE_CONTENT : COLORS.WHITE;
}

export function LogoMark({ tier = null, activeDot = -1, height = 8 }: LogoMarkProps) {
  const rows = Array.from({ length: Math.max(2, height) }, (_, idx) => idx);

  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const barColor = row <= 1 ? COLORS.WHITE : COLORS.BLUE_FRAME;
        return (
          <Box key={row}>
            {row === 0 ? (
              <>
                <Text color={COLORS.WHITE}>{dotGlyph(0, activeDot, tier)}</Text>
                <Text color={COLORS.WHITE}> </Text>
                <Text color={COLORS.WHITE}>{dotGlyph(1, activeDot, tier)}</Text>
              </>
            ) : row === 1 ? (
              <>
                <Text color={COLORS.WHITE}>{dotGlyph(2, activeDot, tier)}</Text>
                <Text color={COLORS.WHITE}> </Text>
                <Text color={COLORS.WHITE}>{dotGlyph(3, activeDot, tier)}</Text>
              </>
            ) : (
              <Text>   </Text>
            )}
            <Text> </Text>
            <Text color={barColor}>█ █</Text>
          </Box>
        );
      })}
    </Box>
  );
}
