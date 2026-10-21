// The project's object layout, applied after Biome (which cannot align values): object
// literals with two or more properties, one of them `key: value`, are written one property per
// line with the colons aligned on the longest key and no trailing comma; arrays and call
// arguments made only of such objects hug them ('[{', '}, {', '}]', 'push({', '})').
// Interfaces and multi-line type literals get the same colons aligned on the longest member
// name (`readonly` and `?` included); method and index signatures are left as they are.
// Runs of class fields and of assignments (`const x = `, `this.x = `, `x += `) align their
// `:` / `=` the same way; in a run mixing types and values both sit one space after the
// longest key. Comments do not end a run; a blank line or any other statement does.
//
//   bun scripts/alignObjects.ts src tests      rewrites the files
//   bun scripts/alignObjects.ts --check src    lists the files that would change (exit code 1)
//
// Objects holding comments it cannot place, or multi-line template strings, are left as they are.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const INDENT       = '  '
/** Rewrites per file at most: each one formats a single object or array. */
const MAX_REWRITES = 5000

/** A range of the text and what it should read. */
interface Rewrite {
  start : number
  end   : number
  layout: string
}

const lineStartOf = (text: string, position: number): number => text.lastIndexOf('\n', position - 1) + 1
const indentAt    = (text: string, position: number): string => /^[ \t]*/.exec(text.slice(lineStartOf(text, position)))?.[0] ?? ''

/** True for objects laid out one property per line. */
function isMultiLineObject(node: ts.Node): node is ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length < 2) return false
  return node.properties.some(ts.isPropertyAssignment)
}

function hasMultiLineTemplate(node: ts.Node, text: string): boolean {
  let found   = false
  const visit = (child: ts.Node) => {
    if (found) return
    if ((ts.isTemplateExpression(child) || ts.isNoSubstitutionTemplateLiteral(child)) && text.slice(child.getStart(), child.end).includes('\n')) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

/** Text between the children and the closing bracket must be blank apart from commas: comments there have no safe place. */
function onlySeparators(text: string): boolean {
  return /^[\s,]*$/.test(text)
}

/** Moves every line after the first by the change of indentation of the text's first line. */
function reindent(text: string, fromIndent: string, toIndent: string): string {
  const delta = toIndent.length - fromIndent.length
  if (delta === 0 || !text.includes('\n')) return text
  return text
    .split('\n')
    .map((line, i) => {
      if (i === 0 || line.trim() === '') return i === 0 ? line : ''
      const leading = /^ */.exec(line)?.[0].length ?? 0
      return ' '.repeat(Math.max(0, leading + delta)) + line.slice(leading)
    })
    .join('\n')
}

/** The object one property per line, colons aligned; null when it cannot be laid out safely. */
function layoutObject(node: ts.ObjectLiteralExpression, text: string): string | null {
  if (hasMultiLineTemplate(node, text)) return null
  const base      = indentAt(text, node.getStart())
  const inner     = base + INDENT
  const keyWidth  = Math.max(...node.properties.filter(ts.isPropertyAssignment).map((property) => property.name.getText().length))
  const lines     = ['{']
  let previousEnd = node.getStart() + 1
  for (const [i, property] of node.properties.entries()) {
    for (const comment of ts.getLeadingCommentRanges(text, property.getFullStart()) ?? []) {
      // A comment on the line of the previous property belongs to it: no safe place for it here.
      if (!text.slice(previousEnd, comment.pos).includes('\n') && i > 0) return null
      lines.push(inner + reindent(text.slice(comment.pos, comment.end), indentAt(text, comment.pos), inner))
    }
    const start      = property.getStart()
    const fromIndent = indentAt(text, start)
    const content    = ts.isPropertyAssignment(property)
      ? `${property.name.getText().padEnd(keyWidth)}: ${reindent(property.initializer.getText(), fromIndent, inner)}`
      : reindent(property.getText(), fromIndent, inner)
    lines.push(inner + content + (i < node.properties.length - 1 ? ',' : ''))
    previousEnd = property.end
  }
  if (!onlySeparators(text.slice(previousEnd, node.end - 1))) return null
  lines.push(`${base}}`)
  return lines.join('\n')
}

/**
 * A list (array elements, call arguments) made only of multi-line objects, hugging them: the
 * text from `start` (after the opening bracket) to `end` (the closing one). Null for other lists.
 */
function hugObjects(items: ts.NodeArray<ts.Node>, start: number, end: number, text: string): Rewrite | null {
  if (items.length === 0 || !items.every(isMultiLineObject)) return null
  let previousEnd = start
  for (const item of items) {
    if (!onlySeparators(text.slice(previousEnd, item.getStart()))) return null
    previousEnd = item.end
  }
  if (!onlySeparators(text.slice(previousEnd, end))) return null
  return {
    start,
    end,
    layout: items.map((item) => item.getText()).join(', ')
  }
}

/** True when each member starts its own line. */
function oneMemberPerLine(members: ts.NodeArray<ts.TypeElement>, text: string): boolean {
  return members.every((member) => text.slice(lineStartOf(text, member.getStart()), member.getStart()).trim() === '')
}

/** An interface or multi-line type literal with the colons of its properties aligned; null when there is nothing to align. */
function alignTypeMembers(node: ts.InterfaceDeclaration | ts.TypeLiteralNode, text: string): Rewrite | null {
  const properties = node.members.filter((member): member is ts.PropertySignature => ts.isPropertySignature(member) && member.type != null)
  if (properties.length < 2 || !oneMemberPerLine(node.members, text)) return null
  const nameEnd  = (property: ts.PropertySignature) => property.questionToken?.end ?? property.name.end
  const keyWidth = Math.max(...properties.map((property) => nameEnd(property) - property.getStart()))
  const start    = node.getStart()
  let layout     = text.slice(start, node.end)
  // From the last property up, so earlier positions stay valid.
  for (const property of [...properties].reverse()) {
    const keyEnd    = nameEnd(property)
    const typeStart = (property.type as ts.TypeNode).getStart()
    const padding   = ' '.repeat(keyWidth - (keyEnd - property.getStart()))
    layout          = `${layout.slice(0, keyEnd - start)}${padding}: ${layout.slice(typeStart - start)}`
  }
  return {
    start,
    end: node.end,
    layout
  }
}

/** A field or assignment: its key (`private readonly name`, `const x`, `this.x`) and the separator after it. */
interface Alignable {
  keyStart      : number
  keyEnd        : number
  separatorStart: number
  separator     : 'type' | 'value'
}

const isAssignmentOperator = (kind: ts.SyntaxKind) => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/** The key and separator of a class field or an assignment statement; null for anything else. */
function alignableOf(node: ts.Node, text: string): Alignable | null {
  let keyEnd        : number
  let separator     : Alignable['separator']
  let separatorStart: number
  if (ts.isPropertyDeclaration(node) || (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1)) {
    const declaration = ts.isPropertyDeclaration(node) ? node : node.declarationList.declarations[0]
    keyEnd            = (('questionToken' in declaration ? declaration.questionToken : undefined) ?? declaration.exclamationToken ?? declaration.name).end
    if (declaration.type) {
      separator      = 'type'
      separatorStart = text.indexOf(':', keyEnd)
    } else if (declaration.initializer) {
      separator      = 'value'
      separatorStart = text.indexOf('=', keyEnd)
    } else {
      return null
    }
  } else if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && isAssignmentOperator(node.expression.operatorToken.kind)) {
    keyEnd         = node.expression.left.end
    separator      = 'value'
    separatorStart = node.expression.operatorToken.getStart()
  } else {
    return null
  }
  const keyStart = node.getStart()
  if (text.slice(keyStart, keyEnd).includes('\n') || text.slice(keyEnd, separatorStart).trim() !== '') return null
  return { keyStart, keyEnd, separatorStart, separator }
}

/** The first run of fields or assignments among `nodes` whose alignment differs from the text. */
function alignRuns(nodes: readonly ts.Node[], text: string): Rewrite | null {
  let run         : Alignable[] = []
  const flush     = (): Rewrite | null => {
    const members = run
    run           = []
    if (members.length < 2) return null
    const keyWidth = Math.max(...members.map((member) => member.keyEnd - member.keyStart))
    const gap      = members.some((member) => member.separator === 'value') ? 1 : 0
    const start    = members[0].keyStart
    const end      = members[members.length - 1].separatorStart
    let layout     = text.slice(start, end)
    for (const member of [...members].reverse()) {
      const padding = ' '.repeat(keyWidth - (member.keyEnd - member.keyStart) + gap)
      layout        = layout.slice(0, member.keyEnd - start) + padding + layout.slice(member.separatorStart - start)
    }
    return layout === text.slice(start, end) ? null : { start, end, layout }
  }
  let previousEnd = -1
  for (const node of nodes) {
    const member         = alignableOf(node, text)
    const afterBlankLine = previousEnd >= 0 && /\n[ \t]*\r?\n/.test(text.slice(previousEnd, node.getStart()))
    previousEnd          = node.end
    if (member && !afterBlankLine) {
      run.push(member)
      continue
    }
    const rewrite = flush()
    if (rewrite) return rewrite
    if (member) run.push(member)
  }
  return flush()
}

function rewriteOf(node: ts.Node, text: string): Rewrite | null {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) return alignTypeMembers(node, text)
  if (ts.isClassLike(node)) return alignRuns(node.members, text)
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return alignRuns(node.statements, text)
  }
  if (isMultiLineObject(node)) {
    const layout = layoutObject(node, text)
    return layout == null ? null : {
      start: node.getStart(),
      end  : node.end,
      layout
    }
  }
  if (ts.isArrayLiteralExpression(node)) return hugObjects(node.elements, node.getStart() + 1, node.end - 1, text)
  if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.length) {
    return hugObjects(node.arguments, node.arguments.pos, node.end - 1, text)
  }
  return null
}

/** The first rewrite, outermost first, that changes the text. */
function nextRewrite(source: ts.SourceFile, text: string): Rewrite | null {
  let found   : Rewrite | null = null
  const visit = (node: ts.Node) => {
    if (found) return
    const rewrite = rewriteOf(node, text)
    if (rewrite && rewrite.layout !== text.slice(rewrite.start, rewrite.end)) {
      found = rewrite
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The file's text with every literal laid out. */
function alignedText(path: string, original: string): string {
  let text = original
  for (let rewrite = 0; rewrite < MAX_REWRITES; rewrite += 1) {
    const next = nextRewrite(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), text)
    if (!next) return text
    text = text.slice(0, next.start) + next.layout + text.slice(next.end)
  }
  throw new Error(`${path}: the layout does not settle`)
}

const checkOnly = process.argv.includes('--check')

/** Aligns a file (or only checks it); true when it was not aligned. */
function alignFile(path: string): boolean {
  const original = readFileSync(path, 'utf8')
  const aligned  = alignedText(path, original)
  if (aligned === original) return false
  if (!checkOnly) writeFileSync(path, aligned)
  return true
}

function* typeScriptFiles(path: string): Generator<string> {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) yield* typeScriptFiles(join(path, name))
  } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
    yield path
  }
}

const changed = process.argv
  .slice(2)
  .filter((arg) => arg !== '--check')
  .flatMap((root) => [...typeScriptFiles(root)])
  .filter(alignFile)
for (const path of changed) console.log(`${checkOnly ? 'not aligned' : 'aligned'}: ${path}`)
if (checkOnly && changed.length) process.exit(1)
