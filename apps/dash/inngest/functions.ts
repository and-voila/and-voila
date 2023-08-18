/* eslint-disable no-console */
import { Redis } from '@upstash/redis';
import { Inngest } from 'inngest';
import { OpenAI } from 'langchain/llms/openai';
import { StructuredOutputParser } from 'langchain/output_parsers';
import { PromptTemplate } from 'langchain/prompts';

// this server function will be deployed to edge
export const runtime = 'edge';

export const PROMPT_SYSTEM_WRITING_ANALYSIS = `You will act as an expert writing analyst to accurately characterize a provided text sample's unique writing style. This will help generate content matching the original author's voice.

I will supply a text sample of at least 500 words, specifying the genre/purpose if known, to allow sufficient analysis. You may request clarification on the text as needed. Identify any distinct sections in the sample (introduction, conclusion, etc).

Analyze the following style descriptors:

[Writing Tone]
[Sentence Structure]

[Vocabulary Choice]
[Grammar & Syntax]
[Descriptive Language]
[Pacing]
[Perspective]

[Structure/Organization]
[Humor]

For each category, provide 3 distinctive keywords that exemplify attributes of the author's style, ranked from most to least relevant. No duplicates across categories.

Additionally, include 1 representative excerpt from the text per keyword category to support your choices. Focus on concise and precise keywords over vague descriptions.

Provide [Unique Vocabulary] examples of 3 unusual adverbs used. Also compare the overall style to established archetypes/authors.

Present under the heading "Your Writing Style Keywords", formatted as:

[Category - Keyword1 (excerpt), Keyword2 (excerpt), Keyword3 (excerpt)]
`;

// init langchain model
const llm = new OpenAI({
  modelName: 'gpt-3.5-turbo',
  temperature: 0.8,
  openAIApiKey: process.env.OPENAI_API_KEY,
});

// init inggest function
export const inngest = new Inngest({
  name: 'Writing assistant',
  eventKey: process.env.INNGEST_EVENT_KEY!,
});

const redis = new Redis({
  url: 'https://adapted-feline-44562.upstash.io',
  token:
    'Aa4SACQgODk1MGFmNWMtZTgwZS00NjgxLTllMjQtOGEwNjY5MTNiYTNlM2NiNjM1ODRjMjgzNDk0OWI4ZWZhMWFiMGVhN2QzYWQ=',
});

const parserString = (key: string) =>
  `${key} an array of keywords that exemplify attributes of the author's style, ranked from most to least relevant. No duplicates across categories include 1 representative excerpt from the text per keyword category to support your choices. Focus on concise and precise keywords over vague descriptions`;

export type WritingStyleType = {
  [key: string]: string[];
  writtingTones: string[];
  sentenceStructure: string[];
  vocabularySturcture: string[];
  grammarSynatx: string[];
  descriptiveLanguage: string[];
  pacing: string[];
  perspective: string[];
  stuctureOrganization: string[];
  humor: string[];
  uniqueVocabulary: string[];
};

const parser = StructuredOutputParser.fromNamesAndDescriptions({
  writtingTones: parserString('Writting tones'),
  sentenceStructure: parserString('Sentence structure'),
  vocabularySturcture: parserString('Vocabulary structure'),
  grammarSynatx: parserString('Grammar & synatx'),
  descriptiveLanguage: parserString('Descriptive language'),
  pacing: parserString('Pacing'),
  perspective: parserString('Perspective'),
  stuctureOrganization: parserString('Stucture & organization'),
  humor: parserString('Humor'),
  uniqueVocabulary: parserString('Unique vocabulary'),
});

const formatInstructions = parser.getFormatInstructions();

const prompt = new PromptTemplate({
  template: `${PROMPT_SYSTEM_WRITING_ANALYSIS}: \n{format_instructions}
    Here is the content sample to analyze:{sample}`,
  inputVariables: ['sample'],
  partialVariables: { format_instructions: formatInstructions },
});

const promptGenerateBlogpost = new PromptTemplate({
  template: '{writtingstyle} {idea}',
  inputVariables: ['writtingstyle', 'idea'],
});

type ResponseRedis = {
  status: 'pending' | 'completed';
  writtingAnalysis: WritingStyleType;
};

// first step analysis four blog posts
export const createWritingAnalysis = inngest.createFunction(
  {
    name: 'Writing analysis',
  },
  {
    event: 'app/writing-analysis',
  },
  async ({ event, step }) => {
    // get data from event four blog posts and username
    const { userId, samples } = event.data as {
      userId: string;
      samples: string[];
    };

    await step.run('start analysis', async () => {
      await redis.set(userId, {
        status: 'pending',
      });
    });

    // map over samples and run analysis chain
    const analysizedSamples = await Promise.all(
      samples.map(async (sample, i) => {
        const sampleAnalysis = await step.run(
          `sample analysis sample: ${i}`,
          async () => {
            const input = await prompt.format({
              sample: sample,
            });
            const response = await llm.call(input);
            console.log('ANALYSIS', response);
            return response;
          },
        );
        return sampleAnalysis;
      }),
    );

    // save analysized samples to KV
    await step.run('save post', async () => {
      const writtingAnalysis: WritingStyleType = {
        writtingTones: [],
        sentenceStructure: [],
        vocabularySturcture: [],
        grammarSynatx: [],
        descriptiveLanguage: [],
        pacing: [],
        perspective: [],
        stuctureOrganization: [],
        humor: [],
        uniqueVocabulary: [],
      };

      analysizedSamples.forEach((sample) => {
        try {
          const parsedSample = JSON.parse(sample.trim());
          for (const key in parsedSample) {
            if (writtingAnalysis.hasOwnProperty(key)) {
              const writingKey = key as keyof WritingStyleType;
              parsedSample[key].forEach((value: string) => {
                if (!writtingAnalysis[writingKey].includes(value)) {
                  writtingAnalysis[writingKey].push(value);
                }
              });
            }
          }
        } catch (error) {
          console.error('Error parsing JSON:', error);
          console.log('Problematic JSON sample:', sample);
        }
      });

      await redis.set(userId, {
        status: 'completed',
        writtingAnalysis: writtingAnalysis,
      });
    });
  },
);

// second step generate blog post
export const createBlogPostGenerator = inngest.createFunction(
  {
    name: 'Generate blog post',
  },
  {
    event: 'app/generate-blogpost',
  },
  async ({ event, step }) => {
    const { idea, userId } = event.data as {
      userId: string;
      idea: string;
    };

    const userData = await step.run('get user data', async () => {
      const res = (await redis.get(userId)) as ResponseRedis;
      return res;
    });

    const writtingAnalysis = await Promise.all(
      Object.entries(userData.writtingAnalysis).map(async ([key, values]) => {
        const formattedValues = values.map((value) =>
          value.replace(/ \(excerpt\)/g, ''),
        );
        return `${key
          .replace(/([A-Z])/g, ' $1')
          .trim()}: ${formattedValues.join(', ')}`;
      }),
    );

    await step.run('generate blog post', async () => {
      const formattedPrompt = writtingAnalysis.join('\n\n');

      const input = await promptGenerateBlogpost.format({
        writtingstyle: formattedPrompt,
        idea: idea,
      });
      const response = await llm.call(input);
      console.log('BLOG POST', response);
      await redis.set(userId, {
        status: 'completed',
        blogPost: response,
      });
      return response;
    });
  },
);
