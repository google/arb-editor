// Copyright 2022 Google LLC
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     https://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict';

import { JSONPath, visit } from 'jsonc-parser';
import XRegExp = require('xregexp');

export class Parser {

	parse(document: string): [MessageList, Literal[]] {
		let isReference: boolean = false;
		const messages = new Map<Literal, Message>();
		const metadata = new Map<Literal, Metadata>();

		let nestingLevel = 0;
		let inReferenceTag = false;
		let placeholderLevel: number | null;
		let metadataLevel: number | null;
		let metadataKey: Literal | null;
		let messageKey: Literal | null;
		let definedPlaceholders: Literal[] = [];
		let errors: Literal[] = [];
		visit(document, {
			onLiteralValue: (value: any, offset: number) => {
				if (inReferenceTag) {
					isReference = (value === true);
					inReferenceTag = false;
				} else if (nestingLevel === 1 && messageKey !== null) {
					try {
						var message = parseMessage(value, offset, false);
						messages.set(messageKey!, message);
					} catch (error: any) {
						//Very hacky solution to catch all errors here and store them, but better than not checking at all... The error has no special type, unfortunately.
						if (String(error).startsWith('Error: Unbalanced ')) {
							errors.push(new Literal(String(error), offset + 1, offset + value.length + 1));
						} else {
							throw error;
						}
					}
				}
			},
			onObjectBegin: (offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				nestingLevel++;
			},
			onObjectProperty: (property: string, offset: number, length: number, startLine: number, startCharacter: number, pathSupplier: () => JSONPath) => {
				const literal = new Literal(property, offset + 1, offset + property.length + 1);
				if (placeholderLevel === nestingLevel - 1) {
					definedPlaceholders.push(literal);
				}
				if (nestingLevel === 1) {
					const isMetadata = property.startsWith('@');
					if (isMetadata) {
						const isGlobalMetadata = property.startsWith('@@');
						if (isGlobalMetadata) {
							if (property === '@@x-reference') {
								inReferenceTag = true;
							}
						} else {
							metadataKey = literal;
							metadataLevel = nestingLevel;
						}
						messageKey = null;
					} else {
						messageKey = literal;
					}
				}
				if (metadataLevel === nestingLevel - 1 && property === 'placeholders') {
					placeholderLevel = nestingLevel;
				}
			},
			onObjectEnd: (offset: number, length: number, startLine: number, startCharacter: number) => {
				nestingLevel--;
				if (placeholderLevel !== null && nestingLevel < placeholderLevel) {
					placeholderLevel = null;
				}
				if (metadataLevel !== null && nestingLevel <= metadataLevel) {
					metadataLevel = -1;
					metadata.set(metadataKey!, new Metadata([...definedPlaceholders]));
					definedPlaceholders = [];
					metadataKey = null;
				}
			},
		}, { disallowComments: true });


		function parseMessage(messageString: string, globalOffset: number, expectPlaceholder: boolean): Message {
			const vals = matchCurlyBrackets(messageString);

			if (vals.length === 0) {
				const literal = new Literal(messageString, globalOffset, globalOffset + messageString.length);
				if (expectPlaceholder) {
					return new Placeholder(literal);
				} else {
					return new StringMessage(literal);
				}
			}
			const submessages: Message[] = [];
			for (const part of vals) {
				const isSubmessage = part.name === 'content';
				const isString = part.name === 'outside';
				if (isSubmessage || isString) {
					if (isSubmessage && part.value.includes(',')) {
						submessages.push(parseComplexMessage(part));
					} else {
						submessages.push(parseMessage(part.value, globalOffset + part.start + 1, isSubmessage));
					}
				}
			}

			if (submessages.length > 1) {
				return new CombinedMessage(globalOffset, globalOffset + messageString.length, submessages);
			} else {
				return submessages[0];
			}

			/**
			* Decorate ICU Message of type `select`, `plural`, or `gender`
			*/
			function parseComplexMessage(part: XRegExp.MatchRecursiveValueNameMatch): ComplexMessage {
				const submessages = new Map<Literal, Message>();
				const firstComma = part.value.indexOf(',');
				var start = globalOffset + part.start + 1;
				var end = globalOffset + part.start + firstComma + 1;

				const argument = new Literal(part.value.substring(0, firstComma), start, end);

				start = firstComma + 1;
				const secondComma = part.value.indexOf(',', start);
				end = secondComma;
				({ start, end } = trim(part.value, start, end));
				const complexType = new Literal(part.value.substring(start, end), globalOffset + part.start + start + 1, globalOffset + part.start + end + 1);
				start = secondComma + 1;
				const bracketedValues = matchCurlyBrackets(part.value);
				for (const innerPart of bracketedValues) {
					if (innerPart.name === 'content') {
						end = innerPart.start - 1;
						({ start, end } = trim(part.value, start, end));
						var submessagekey = new Literal(part.value.substring(start, end), globalOffset + part.start + start + 1, globalOffset + part.start + end + 1);
						var message = parseMessage(innerPart.value, globalOffset + part.start + innerPart.start, false);
						submessages.set(submessagekey, message);
						start = innerPart.end + 1;
					}
				}
				return new ComplexMessage(globalOffset + part.start, globalOffset + part.end, argument, complexType, submessages);
			}

			function trim(text: string, start: number, end: number) {
				while (text.charAt(start) === ' ') {
					start++;
				}
				while (text.charAt(end - 1) === ' ') {
					end--;
				}
				return { start, end };
			}
		}

		return [new MessageList(isReference, messages, metadata), errors];
	}
}
function matchCurlyBrackets(value: string): XRegExp.MatchRecursiveValueNameMatch[] {
	return XRegExp.matchRecursive(value, '\\{', '\\}', 'g', {
		valueNames: ['outside', 'leftBracket', 'content', 'rightBracket'],
		escapeChar: '\'',
		unbalanced: 'error'
	});
}

export class Literal {
	constructor(
		public value: string,
		public start: number,
		public end: number
	) { }

	public toString = (): string => {
		return `Literal(${this.value},${this.start},${this.end})`;
	};

	whereIs(offset: number): Literal | Message | null {
		if (this.start < offset && offset < this.end) {
			return this;
		} else {
			return null;
		}
	}
}

export class MessageList {
	constructor(
		public isReference: boolean,
		public messages: Map<Literal, Message>,
		public metadata: Map<Literal, Metadata>
	) { }

	getPlaceholders(): Literal[] {
		return Array.from(this.messages.values()).flatMap((message) => message.getPlaceholders());
	}

	getMessageAt(offset: number): Message | Literal | Metadata | null {
		const partsContaining = Array.from(this.messages.entries()).filter(([literal, message]) => literal.whereIs(offset) !== null || message.whereIs(offset) !== null);
		if (partsContaining.length > 0) {
			return partsContaining[0][0].whereIs(offset) ?? partsContaining[0][1].whereIs(offset);
		} else {
			return null;
		}
	}
}

export class Metadata {
	constructor(
		public placeholders: Literal[]
	) { }
}

export abstract class Message {
	constructor(
		public start: number,
		public end: number,
	) { }

	abstract getPlaceholders(): Literal[];

	abstract whereIs(offset: number): Message | Literal | null;
}

export class CombinedMessage extends Message {
	constructor(
		start: number,
		end: number,
		public parts: Message[]
	) {
		super(start, end);
	}

	getPlaceholders(): Literal[] {
		return this.parts.flatMap((value) => value.getPlaceholders());
	}

	whereIs(offset: number): Literal | Message | null {
		if (this.start < offset && offset < this.end) {
			const partsContaining = this.parts.filter((part) => part.whereIs(offset) !== null);
			if (partsContaining.length > 0) {
				return partsContaining[0].whereIs(offset);
			} else {
				return null;
			}
		}
		return null;
	}
}

export class StringMessage extends Message {
	constructor(
		public value: Literal,
	) {
		super(value.start, value.end);
	}

	getPlaceholders(): Literal[] {
		return [];
	}

	whereIs(offset: number): Literal | Message | null {
		if (this.start < offset && offset < this.end) {
			return this;
		} else {
			return null;
		}
	}
}

export class ComplexMessage extends Message {
	constructor(
		start: number,
		end: number,
		public argument: Literal,
		public complexType: Literal,
		public messages: Map<Literal, Message>
	) {
		super(start, end);
	}

	getPlaceholders(): Literal[] {
		return [this.argument, ...Array.from(this.messages.values()).flatMap((value) => value.getPlaceholders())];
	}

	whereIs(offset: number): Literal | Message | null {
		if (this.start < offset && offset < this.end) {
			const partsContaining = Array.from(this.messages.entries()).filter(([literal, message]) => literal.whereIs(offset) !== null || message.whereIs(offset) !== null);
			if (partsContaining.length > 0) {
				return partsContaining[0][0].whereIs(offset) ?? partsContaining[0][1].whereIs(offset);
			} else {
				return null;
			}
		}
		return null;
	}
}

export class Placeholder extends Message {
	constructor(
		public placeholder: Literal
	) {
		super(placeholder.start, placeholder.end);
	}

	getPlaceholders(): Literal[] {
		return [this.placeholder];
	}

	whereIs(offset: number): Literal | Message | null {
		if (this.start < offset && offset < this.end) {
			return this;
		} else {
			return null;
		}
	}
}
