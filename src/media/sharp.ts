import sharp from 'sharp';

sharp.block({ operation: ['VipsForeignLoadSvg', 'VipsForeignLoadPdf', 'VipsForeignLoadMagick', 'VipsForeignLoadTiff'] });

export default sharp;
export type { Metadata } from 'sharp';
