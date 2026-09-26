import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

export type ErrorImageSource = 'camera' | 'gallery';

export type ExtractedError = {
  text: string;
  imageUri: string;
  source: ErrorImageSource;
};

export async function extractErrorFromImage(source: ErrorImageSource): Promise<ExtractedError | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error('On-device image reading is available in the installed phone app.');
  }

  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Camera permission is needed to scan an error. You can still paste text.');
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  };
  const selection = source === 'camera'
    ? await ImagePicker.launchCameraAsync(options)
    : await ImagePicker.launchImageLibraryAsync(options);

  if (selection.canceled) return null;
  const asset = selection.assets[0];
  if (!asset?.uri) throw new Error('The image could not be opened. Please try again.');

  // The recognizer runs on the phone. Only the editable text is later sent to the laptop.
  const { default: MlkitOcr } = await import('rn-mlkit-ocr');
  const result = await MlkitOcr.recognizeText(asset.uri, 'latin');
  const text = result.text.replace(/\r\n/g, '\n').trim();
  if (text.length < 12) throw new Error('Not enough readable error text was found. Try a sharper image or paste the error.');
  return { text: text.slice(0, 20_000), imageUri: asset.uri, source };
}
