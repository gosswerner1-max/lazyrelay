import { BrandMark } from "./BrandMark";

export function Spinner({ size = 40 }: { size?: number }) {
  return (
    <div className="spinner">
      <BrandMark size={size} />
    </div>
  );
}
