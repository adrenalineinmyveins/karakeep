import SaiyeFull from "@/public/icons/saiye-full.svg";

export default function SaiyeLogo({ height }: { height: number }) {
  return (
    <span className="flex items-center">
      <SaiyeFull height={height} className={`fill-foreground`} />
    </span>
  );
}
