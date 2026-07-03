import { useRef, useState, useCallback } from 'react';
import type { TouchEvent } from 'react';

interface UseSwipeOptions {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  threshold?: number;
}

export function useSwipe({ onSwipeLeft, onSwipeRight, threshold = 100 }: UseSwipeOptions) {
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [animatingOut, setAnimatingOut] = useState<'left' | 'right' | null>(null);

  const startX = useRef(0);
  const currentX = useRef(0);

  const onTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (animatingOut) return;
    startX.current = e.touches[0].clientX;
    currentX.current = e.touches[0].clientX;
    setIsDragging(true);
  }, [animatingOut]);

  const onTouchMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    currentX.current = e.touches[0].clientX;
    setOffset(currentX.current - startX.current);
  }, [isDragging]);

  const onTouchEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);
    
    const finalOffset = currentX.current - startX.current;
    
    if (finalOffset > threshold) {
      setAnimatingOut('right');
      onSwipeRight();
    } else if (finalOffset < -threshold) {
      setAnimatingOut('left');
      onSwipeLeft();
    } else {
      setOffset(0);
    }
  }, [isDragging, threshold, onSwipeLeft, onSwipeRight]);

  const reset = useCallback(() => {
    setOffset(0);
    setAnimatingOut(null);
  }, []);

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    offset,
    isDragging,
    animatingOut,
    reset,
  };
}
