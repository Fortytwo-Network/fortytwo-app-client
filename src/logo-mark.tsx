import { Box, Text } from "ink";
import { COLORS } from "./constants.js";

export type LogoTier = "challenger" | "capable" | null;
type DotGlyph = "●" | "■" | "▶" | "▲";

// 2x2 dot animation frames:
// [top-left, top-right, bottom-left, bottom-right]
const LOGO_DOT_FRAMES: DotGlyph[][] = [
  ["●", "●", "●", "●"],
  ["●", "●", "■", "●"],
  ["●", "●", "▶", "●"],
  ["●", "■", "▶", "●"],
  ["■", "■", "▶", "●"],
  ["■", "■", "▶", "■"],
  ["■", "▲", "▶", "■"],
  ["▲", "▲", "▶", "■"],
  ["▲", "▲", "■", "■"],
  ["▲", "▲", "■", "▲"],
  ["▲", "■", "■", "▲"],
  ["■", "■", "■", "▲"],
  ["■", "■", "●", "▲"],
  ["■", "■", "●", "■"],
  ["■", "●", "●", "■"],
  ["●", "●", "●", "■"],
  ["●", "●", "●", "●"],
];

export const LOGO_DOT_FRAME_COUNT = LOGO_DOT_FRAMES.length;

interface LogoMarkProps {
  tier?: LogoTier;
  activeDot?: number;
  height?: number;
}

function frameFor(index: number): DotGlyph[] {
  const safe = ((index % LOGO_DOT_FRAME_COUNT) + LOGO_DOT_FRAME_COUNT) % LOGO_DOT_FRAME_COUNT;
  return LOGO_DOT_FRAMES[safe];
}

export function LogoMark({ tier = null, activeDot = -1, height = 8 }: LogoMarkProps) {
  const rows = Array.from({ length: Math.max(2, height) }, (_, idx) => idx);
  const frame = frameFor(activeDot < 0 ? 0 : activeDot);
  const [topLeft, topRight, bottomLeft, bottomRight] = frame;
  void tier;

  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const barColor = row <= 1 ? COLORS.WHITE : COLORS.BLUE_FRAME;
        return (
          <Box key={row}>
            {row === 0 ? (
              <>
                <Text color={COLORS.WHITE}>{topLeft}</Text>
                <Text color={COLORS.WHITE}> </Text>
                <Text color={COLORS.WHITE}>{topRight}</Text>
              </>
            ) : row === 1 ? (
              <>
                <Text color={COLORS.WHITE}>{bottomLeft}</Text>
                <Text color={COLORS.WHITE}> </Text>
                <Text color={COLORS.WHITE}>{bottomRight}</Text>
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
