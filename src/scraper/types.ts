export interface SlideImage {
  src: string;
  alt: string;
}

export interface PopupContent {
  triggerDescription: string;
  text: string[];
  images: SlideImage[];
}

export interface SlideContent {
  slideIndex: number;
  slideTitle: string | null;
  text: string[];
  images: SlideImage[];
  popups: PopupContent[];
}

export interface PresentationTranscript {
  url: string;
  title: string | null;
  totalSlides: number;
  scrapedAt: string;
  slides: SlideContent[];
}

export interface ScrapeOptions {
  url: string;
  timeoutMs?: number;
  clickInteractive?: boolean;
  headless?: boolean;
}
