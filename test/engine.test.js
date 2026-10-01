import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEndpoint, mapParams, extractMedia, buildImagePrompt } from '../public/engine.js';

// Firmas de ejemplo con la forma que devuelve view_api() del cliente de Gradio.
const P = (parameter_name, component, extra = {}) => ({ parameter_name, label: parameter_name, component, ...extra });

const pulidLike = {
  named_endpoints: {
    '/update_ui': { parameters: [P('mode', 'Radio')], returns: [P('out', 'Slider')] },
    '/generate_image': {
      parameters: [
        P('width', 'Slider', { parameter_has_default: true, parameter_default: 896 }),
        P('height', 'Slider', { parameter_has_default: true, parameter_default: 1152 }),
        P('num_steps', 'Slider', { parameter_has_default: true, parameter_default: 20 }),
        P('start_step', 'Slider', { parameter_has_default: true, parameter_default: 0 }),
        P('guidance', 'Slider', { parameter_has_default: true, parameter_default: 4 }),
        P('seed', 'Textbox', { parameter_has_default: true, parameter_default: '-1' }),
        P('prompt', 'Textbox', { parameter_has_default: true, parameter_default: 'portrait' }),
        P('id_image', 'Image'),
        P('id_weight', 'Slider', { parameter_has_default: true, parameter_default: 1 }),
        P('neg_prompt', 'Textbox', { parameter_has_default: true, parameter_default: 'bad' }),
      ],
      returns: [P('output', 'Image'), P('seed', 'Textbox')],
    },
  },
};

const wanLike = {
  named_endpoints: {
    '/generate_video': {
      parameters: [
        P('input_image', 'Image'),
        P('prompt', 'Textbox', { parameter_has_default: true, parameter_default: 'make this image come alive' }),
        P('steps', 'Slider', { parameter_has_default: true, parameter_default: 6 }),
        P('negative_prompt', 'Textbox', { parameter_has_default: true, parameter_default: '' }),
        P('duration_seconds', 'Slider', { parameter_has_default: true, parameter_default: 3.5 }),
        P('seed', 'Slider', { parameter_has_default: true, parameter_default: 42 }),
        P('randomize_seed', 'Checkbox', { parameter_has_default: true, parameter_default: true }),
      ],
      returns: [P('generated_video', 'Video'), P('seed', 'Slider')],
    },
    '/update_dims': { parameters: [P('input_image', 'Image')], returns: [P('h', 'Slider')] },
  },
};

test('elige el endpoint que genera, no el de interfaz', () => {
  assert.equal(pickEndpoint(pulidLike, { output: 'image' }).name, '/generate_image');
  assert.equal(pickEndpoint(wanLike, { output: 'video' }).name, '/generate_video');
});

test('mapea imagen, prompt, negativo y parámetros numéricos conocidos', () => {
  const info = pulidLike.named_endpoints['/generate_image'];
  const img = { fake: 'blob' };
  const m = mapParams(info, { image: img, prompt: 'P', negative: 'N', idWeight: 0.9, seed: 7, width: 832, height: 1216 });
  const by = Object.fromEntries(m.map((x) => [x.param.parameter_name, x.value]));
  assert.equal(by.id_image, img);
  assert.equal(by.prompt, 'P');
  assert.equal(by.neg_prompt, 'N');
  assert.equal(by.id_weight, 0.9);
  assert.equal(by.width, 832);
  assert.equal(by.height, 1216);
  assert.equal(by.seed, '-1', 'una semilla en Textbox conserva su valor por defecto');
  assert.equal(by.num_steps, 20);
});

test('mapea duración, semilla y randomize en el vídeo', () => {
  const info = wanLike.named_endpoints['/generate_video'];
  const m = mapParams(info, { image: 'x', prompt: 'P', negative: 'N', duration: 5, seed: 99, randomize: false });
  const by = Object.fromEntries(m.map((x) => [x.param.parameter_name, x.value]));
  assert.equal(by.duration_seconds, 5);
  assert.equal(by.seed, 99);
  assert.equal(by.randomize_seed, false);
  assert.equal(by.negative_prompt, 'N');
  assert.equal(by.steps, 6);
});

test('extrae la URL de vídeo o imagen de distintas formas de respuesta', () => {
  assert.deepEqual(extractMedia([{ video: { url: 'https://s/a.mp4' } }, 42], 'video'), ['https://s/a.mp4']);
  assert.deepEqual(extractMedia([{ url: 'https://s/out.webp', path: '/tmp/out.webp' }, '123'], 'image'), ['https://s/out.webp']);
  assert.deepEqual(extractMedia([[{ image: { url: 'https://s/g.png' } }]], 'image'), ['https://s/g.png']);
});

test('el prompt de imagen incluye ropa, lugar y realismo', () => {
  const p = buildImagePrompt({ outfit: 'a red coat', scene: 'Paris' });
  assert.match(p, /wearing a red coat/);
  assert.match(p, /in Paris/);
  assert.match(p, /skin texture/);
});
