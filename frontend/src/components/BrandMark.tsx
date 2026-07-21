import icon from "../assets/icon.png";

interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 32 }: BrandMarkProps) {
  return <img src={icon} alt="" width={size} height={size} className="brand-mark" />;
}
