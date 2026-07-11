type BrandIconProps = {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

type BrandWordmarkProps = {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

const iconSizeClasses = {
  sm: 'h-7 w-7 rounded-lg text-xs',
  md: 'h-8 w-8 rounded-lg text-sm',
  lg: 'h-12 w-12 rounded-xl text-lg',
  xl: 'h-16 w-16 rounded-2xl text-2xl',
}

const wordmarkSizeClasses = {
  sm: 'h-8 w-[160px]',
  md: 'h-10 w-[190px]',
  lg: 'h-12 w-[220px]',
  xl: 'h-16 w-[300px]',
}

export default function BrandMark({ size = 'md', className = '' }: BrandIconProps) {
  return (
    <img
      src="/brand/l-link-icon.png"
      alt=""
      className={`shrink-0 object-cover shadow-sm ${iconSizeClasses[size]} ${className}`}
      aria-hidden="true"
    />
  )
}

export function BrandWordmark({ size = 'md', className = '' }: BrandWordmarkProps) {
  return (
    <img
      src="/brand/l-link-wordmark.png"
      alt="Lリンク"
      className={`shrink-0 object-contain object-left ${wordmarkSizeClasses[size]} ${className}`}
    />
  )
}
