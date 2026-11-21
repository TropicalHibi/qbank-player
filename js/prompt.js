// The ONE source of the LLM prompt template, plus the schema embedded inline so a
// filled prompt works when pasted into a fresh chat with no other context.
//
// SCHEMA below must stay identical to /schema.json — tests/validate.test.mjs enforces this.
// (It is duplicated rather than fetched so create.html works from any static host
// without an extra request and the prompt never ships without its schema.)

export const SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "qbank-player/question-set/v1",
  "title": "qbank-player question set (v1)",
  "description": "A set of single-best-answer multiple-choice questions playable in qbank-player.",
  "type": "object",
  "required": [
    "title",
    "version",
    "questions"
  ],
  "additionalProperties": false,
  "properties": {
    "$schema": {
      "type": "string",
      "description": "Optional pointer to this schema; ignored by the player."
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "description": "Human-readable name of the set."
    },
    "version": {
      "type": "integer",
      "const": 1,
      "description": "Schema version. Must be 1."
    },
    "description": {
      "type": "string",
      "description": "Optional short description shown on the start screen."
    },
    "questions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "$ref": "#/$defs/question"
      }
    }
  },
  "$defs": {
    "question": {
      "type": "object",
      "required": [
        "id",
        "stem",
        "options",
        "answer"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "description": "Unique within the set, e.g. \"q1\"."
        },
        "stem": {
          "type": "string",
          "minLength": 1,
          "description": "Question text. Basic inline markdown allowed: **bold**, *italic*, line breaks (\\n), and simple pipe tables."
        },
        "image": {
          "type": "string",
          "pattern": "^(?:https?://|data:image/|(?![A-Za-z][A-Za-z0-9+.-]*:)).+",
          "description": "Optional image: http(s) URL, relative path, or data:image/ URI."
        },
        "options": {
          "type": "array",
          "minItems": 2,
          "maxItems": 8,
          "items": {
            "$ref": "#/$defs/option"
          }
        },
        "answer": {
          "type": "integer",
          "minimum": 0,
          "description": "Zero-based index of the correct option in \"options\"."
        },
        "discriminator": {
          "type": "string",
          "description": "One line: the key distinction this question tests."
        },
        "explanation": {
          "type": "string",
          "description": "Optional overall explanation shown after answering. Same inline markdown as the stem."
        },
        "explanationImages": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^(?:https?://|data:image/|(?![A-Za-z][A-Za-z0-9+.-]*:)).+"
          },
          "description": "Optional images for the explanation: direct http(s) links, relative paths or data:image/ URIs."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          },
          "description": "Lowercase tags, e.g. [organ system, discipline, specific topic]."
        },
        "source": {
          "type": "string",
          "description": "Optional reference, e.g. \"Sketchy Pharm p.12\"."
        }
      }
    },
    "option": {
      "type": "object",
      "required": [
        "text",
        "explanation"
      ],
      "additionalProperties": false,
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1,
          "description": "The answer choice as shown to the user."
        },
        "explanation": {
          "type": "string",
          "minLength": 1,
          "description": "Why this option is correct or incorrect."
        }
      }
    }
  }
};

export const PROMPT_TEMPLATE = `Generate {N} {STYLE}-style single-best-answer questions on {TOPIC} as ONE JSON file matching the schema below. If I've attached study material, base the questions on it.

Rules:
- Full clinical vignettes (age, sex, presentation, relevant history/exam/labs) unless the concept is purely basic-science.
- {OPTIONS} answer options per question, all plausible and homogeneous (same category).
- Every option gets an explanation of why it is right or wrong.
- Every question gets a one-line "discriminator": the key distinction being tested.
- Every question gets an "explanation": the overall teaching point in a few sentences (same inline formatting as the stem).
- "explanationImages" is optional: include only direct image links you are confident exist; otherwise leave it out.
- Do not cue the topic or diagnosis in the stem; avoid "which of the following is true" list items.
- Distribute correct answer positions evenly; "answer" is the zero-based index.
- Tags: [organ system, discipline, specific topic], lowercase.
- Unique ids q1, q2, ...
- Difficulty: {DIFFICULTY}.{STYLE_NOTES}
- Stems may use **bold**, *italic*, line breaks (\\n) and simple Markdown pipe tables for labs. Leave "image" out unless you have a real image URL.
- Output ONLY valid JSON (no commentary), as a downloadable .json file if you can create files, otherwise in a single code block.

Schema:
{SCHEMA}
`;

export const STYLES = {
  usmle: 'USMLE Step 1',
  comlex: 'COMLEX Level 1',
  both: 'USMLE Step 1 / COMLEX Level 1',
};

const STYLE_NOTES = {
  usmle: '',
  comlex: '\n- Where relevant, include osteopathic principles (somatic dysfunction, OMM, viscerosomatic reflexes) as COMLEX does.',
  both: '\n- Keep content valid for both exams; an occasional osteopathic-principles question is welcome.',
};

export const DIFFICULTIES = {
  standard: 'standard board level, comparable to NBME/NBOME practice exams',
  hard: 'hard: multi-step reasoning (two or three logical jumps from presentation to answer), close distractors, above-average board difficulty',
};

export const DEFAULTS = { n: 10, style: 'usmle', topic: '', options: 5, difficulty: 'standard' };

/**
 * Fill the template.
 * @param {{n?: number, style?: keyof STYLES, topic?: string, options?: number, difficulty?: keyof DIFFICULTIES}} input
 */
export function fillPrompt(input = {}) {
  const o = { ...DEFAULTS, ...input };
  const n = Math.min(200, Math.max(1, Math.round(Number(o.n) || DEFAULTS.n)));
  const options = Math.min(8, Math.max(2, Math.round(Number(o.options) || DEFAULTS.options)));
  const style = STYLES[o.style] ? o.style : DEFAULTS.style;
  const difficulty = DIFFICULTIES[o.difficulty] ? o.difficulty : DEFAULTS.difficulty;
  const topic = String(o.topic || '').trim() || 'high-yield topics from the attached study material (or, if none is attached, a broad high-yield mix)';
  const values = {
    '{N}': String(n),
    '{STYLE}': STYLES[style],
    '{TOPIC}': topic,
    '{OPTIONS}': String(options),
    '{DIFFICULTY}': DIFFICULTIES[difficulty],
    '{STYLE_NOTES}': STYLE_NOTES[style],
    '{SCHEMA}': JSON.stringify(SCHEMA, null, 2),
  };
  let out = PROMPT_TEMPLATE;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  return out;
}

/** A complete, valid one-question set used by "Copy example question". */
export const EXAMPLE_QUESTION = {
  id: 'q1',
  stem:
    'A 34-year-old woman comes to the physician because of fatigue and weight gain over 6 months. She also reports constipation and that she "always feels cold." Her pulse is 54/min. Deep tendon reflexes show delayed relaxation.\n\n| Lab | Value |\n|---|---|\n| TSH | 18 µU/mL (N 0.5–5) |\n| Free T4 | 0.4 ng/dL (N 0.9–1.7) |\n\nWhich of the following is the most likely underlying cause of this patient\'s condition?',
  options: [
    { text: 'Autoantibodies against thyroid peroxidase', explanation: 'Correct. Hashimoto thyroiditis is the most common cause of primary hypothyroidism in iodine-sufficient regions; anti-TPO antibodies are characteristic.' },
    { text: 'Antibodies that stimulate the TSH receptor', explanation: 'Graves disease: TSH-receptor-stimulating antibodies cause hyperthyroidism with low TSH, not high.' },
    { text: 'TSH-secreting pituitary adenoma', explanation: 'Causes secondary hyperthyroidism with high TSH and high free T4; here free T4 is low.' },
    { text: 'Granulomatous inflammation after a viral illness', explanation: 'Subacute (de Quervain) thyroiditis presents with a painful gland and a transient thyrotoxic phase, usually with elevated ESR.' },
    { text: 'Hypothalamic TRH deficiency', explanation: 'Tertiary hypothyroidism gives low/inappropriately normal TSH, not markedly elevated TSH.' },
  ],
  answer: 0,
  explanation:
    'Elevated TSH with low free T4 localizes the problem to the thyroid itself (primary hypothyroidism). In iodine-sufficient regions the most common cause is **Hashimoto thyroiditis**, an autoimmune destruction of the gland marked by anti-TPO antibodies and lymphocytic infiltration with germinal centers. Central (pituitary or hypothalamic) causes produce a low or inappropriately normal TSH.',
  discriminator: 'High TSH + low free T4 = primary hypothyroidism; most often autoimmune (anti-TPO) rather than central causes.',
  tags: ['endocrine', 'pathology', 'hashimoto thyroiditis'],
  source: 'Original example (qbank-player)',
};
