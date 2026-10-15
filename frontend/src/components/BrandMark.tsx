import icon from "../assets/icon.webp";

interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 32 }: BrandMarkProps) {
  return <img src={icon} alt="" width={size} height={size} className="brand-mark" />;
}
