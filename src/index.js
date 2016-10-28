/**
 * Imports
 */

import find from 'lodash/find'

export default function ({ types: t, template }) {
  function isVduxLikeComponentObject (node) {
    return t.isObjectExpression(node) && !!find(node.properties, objectMember => {
      return (
        t.isObjectProperty(objectMember) ||
        t.isObjectMethod(objectMember)
      ) && (
        t.isIdentifier(objectMember.key, { name: 'render' }) ||
        t.isStringLiteral(objectMember.key, { value: 'render' })
      )
    })
  }

  function isVduxLikeComponent (node) {
    return t.isCallExpression(node) && node.callee.name === 'component' && isVduxLikeComponentObject(node.arguments[0])
  }

  function isHocComponent (node, hoc) {
    if (t.isCallExpression(node)) {
      if (t.isCallExpression(node.callee)) {
        return t.isIdentifier(node.callee.callee)
          && hoc.indexOf(node.callee.callee.name) !== -1
      }
    }

    return false
  }

  function isFunctionalComponent (path) {
    const node = path.node

    if (t.isFunctionDeclaration(node)) {
      if (/^[A-Z]/.test(node.id.name)) {
        let foundJsx = false

        path.traverse({
          JSXIdentifier () {
            foundJsx = true
          }
        })

        return foundJsx
      }
    }

    return false
  }

  // `foo({ displayName: 'NAME' })` => 'NAME'
  function getDisplayName (node) {
    const property = find(node.properties, node => node.key.name === 'displayName')
    return property && property.value.value
  }

  function hasParentFunction (path) {
    return !!path.findParent(parentPath => parentPath.isFunction())
  }

  // wrapperFunction("componentId")(node)
  function wrapComponent (node, componentId, wrapperFunctionId) {
    return t.callExpression(
      t.callExpression(wrapperFunctionId, [
        t.stringLiteral(componentId)
      ]),
    [node])
  }

  function wrapFunctionComponent (node, componentId, wrapperFunctionId) {
    const component = toObjectExpression({
      render: t.toExpression(node)
    })

    component[VISITED_KEY] = true
    return t.variableDeclaration('const', [
      t.variableDeclarator(node.id, t.toExpression(wrapComponent(
        component,
        componentId,
        wrapperFunctionId
      )))
    ])
  }

  // `{ name: foo }` => Node { type: "ObjectExpression", properties: [...] }
  function toObjectExpression (object) {
    const properties = Object.keys(object).map(key => {
      return t.objectProperty(t.identifier(key), object[key])
    })

    return t.objectExpression(properties)
  }

  const wrapperFunctionTemplate = template(`
    function WRAPPER_FUNCTION_ID(ID_PARAM) {
      return function(COMPONENT_PARAM) {
        return EXPRESSION
      }
    }
  `)

  const VISITED_KEY = 'vdux-transform-' + Date.now()

  const componentVisitor = {
    FunctionDeclaration (path) {
      if (path.node[VISITED_KEY] || !isFunctionalComponent(path)) {
        return
      }

      path.node[VISITED_KEY] = true

      const componentName = getDisplayName(path.node)
      const componentId = componentName || path.scope.generateUid('component')
      const isInFunction = hasParentFunction(path)

      this.components.push({
        id: componentId,
        name: componentName,
        isInFunction: isInFunction
      })

      path.replaceWith(wrapFunctionComponent(path.node, componentId, this.wrapperFunctionId))
    },

    CallExpression (path) {
      if (path.node[VISITED_KEY] || (!isHocComponent(path.node, this.options.hoc) && !isVduxLikeComponent(path.node))) {
        return
      }

      path.node[VISITED_KEY] = true

      const componentName = getDisplayName(path.node)
      const componentId = componentName || path.scope.generateUid('component')
      const isInFunction = hasParentFunction(path)

      this.components.push({
        id: componentId,
        name: componentName,
        isInFunction: isInFunction
      })

      path.replaceWith(wrapComponent(path.node, componentId, this.wrapperFunctionId))
    }

    // ObjectExpression (path) {
    //   if (path.node[VISITED_KEY] || !isVduxLikeComponentObject(path.node)) {
    //     return
    //   }

    //   path.node[VISITED_KEY] = true

    //   // `foo({ displayName: 'NAME' })` => 'NAME'
    //   const componentName = getDisplayName(path.node)
    //   const componentId = componentName || path.scope.generateUid('component')
    //   const isInFunction = hasParentFunction(path)

    //   this.components.push({
    //     id: componentId,
    //     name: componentName,
    //     isInFunction: isInFunction
    //   })

    //   path.replaceWith(wrapComponent(path.node, componentId, this.wrapperFunctionId))
    // }
  }

  class VduxTransformBuilder {
    constructor (file, options) {
      this.file = file
      this.program = file.path
      this.options = this.normalizeOptions(options)

      // @todo: clean this shit up
      this.configuredTransformsIds = []
    }

    static validateOptions (options) {
      return typeof options === 'object' && Array.isArray(options.transforms)
    }

    static assertValidOptions (options) {
      if (!VduxTransformBuilder.validateOptions(options)) {
        throw new Error(
          'babel-plugin-vdux-transform requires that you specify options ' +
          'in .babelrc or from the Babel Node API, and that it is an object ' +
          'with a transforms property which is an array.'
        )
      }
    }

    normalizeOptions (options) {
      return {
        hoc: options.hoc || [],
        transforms: options.transforms.map(opts => {
          return {
            transform: opts.transform,
            locals: opts.locals || [],
            imports: opts.imports || []
          }
        })
      }
    }

    build () {
      const componentsDeclarationId = this.file.scope.generateUidIdentifier('components')
      const wrapperFunctionId = this.file.scope.generateUidIdentifier('wrapComponent')

      const components = this.collectAndWrapComponents(wrapperFunctionId)

      if (!components.length) {
        return
      }

      const componentsDeclaration = this.initComponentsDeclaration(componentsDeclarationId, components)
      const configuredTransforms = this.initTransformers(componentsDeclarationId)
      const wrapperFunction = this.initWrapperFunction(wrapperFunctionId)

      const body = this.program.node.body

      body.unshift(wrapperFunction)
      configuredTransforms.reverse().forEach(node => body.unshift(node))
      body.unshift(componentsDeclaration)
    }

    /**
     * const Foo = _wrapComponent('Foo')({render: () => <div></div>})
     */
    collectAndWrapComponents (wrapperFunctionId) {
      const components = []

      this.file.path.traverse(componentVisitor, {
        wrapperFunctionId: wrapperFunctionId,
        components: components,
        currentlyInFunction: false,
        options: this.options
      })

      return components
    }

    /**
     * const _components = {
     *   Foo: {
     *     displayName: "Foo"
     *   }
     * }
     */
    initComponentsDeclaration (componentsDeclarationId, components) {
      let uniqueId = 0

      const props = components.map(component => {
        const componentId = component.id
        const componentProps = []

        if (component.name) {
          componentProps.push(t.objectProperty(
            t.identifier('displayName'),
            t.stringLiteral(component.name)
          ))
        }

        if (component.isInFunction) {
          componentProps.push(t.objectProperty(
            t.identifier('isInFunction'),
            t.booleanLiteral(true)
          ))
        }

        let objectKey

        if (t.isValidIdentifier(componentId)) {
          objectKey = t.identifier(componentId)
        } else {
          objectKey = t.stringLiteral(componentId)
        }

        return t.objectProperty(objectKey, t.objectExpression(componentProps))
      })

      return t.variableDeclaration('const', [
        t.variableDeclarator(componentsDeclarationId, t.objectExpression(props))
      ])
    }

    /**
     * import _transformLib from "transform-lib"
     * ...
     * const _transformLib2 = _transformLib({
     *   filename: "filename",
     *   components: _components,
     *   locals: [],
     *   imports: []
     * })
     */
    initTransformers (componentsDeclarationId) {
      return this.options.transforms.map(transform => {
        const transformName = transform.transform
        const transformImportId = this.file.addImport(transformName, 'default', transformName)

        const transformLocals = transform.locals.map(local => {
          return t.identifier(local)
        })

        const transformImports = transform.imports.map(importName => {
          return this.file.addImport(importName, 'default', importName)
        })

        const configuredTransformId = this.file.scope.generateUidIdentifier(transformName)
        const configuredTransform = t.variableDeclaration('const', [
          t.variableDeclarator(
            configuredTransformId,
            t.callExpression(transformImportId, [
              toObjectExpression({
                filename: t.stringLiteral(this.file.opts.filename),
                components: componentsDeclarationId,
                locals: t.arrayExpression(transformLocals),
                imports: t.arrayExpression(transformImports)
              })
            ])
          )
        ])

        this.configuredTransformsIds.push(configuredTransformId)
        return configuredTransform
      })
    }

    /**
     * function _wrapComponent(id) {
     *   return function (Component) {
     *     return _transformLib2(Component, id)
     *   }
     * }
     */
    initWrapperFunction (wrapperFunctionId) {
      const idParam = t.identifier('id')
      const componentParam = t.identifier('Component')

      const expression = this.configuredTransformsIds
        .reverse()
        .reduce((memo, transformId) => t.callExpression(transformId, [memo, idParam]), componentParam)

      return wrapperFunctionTemplate({
        WRAPPER_FUNCTION_ID: wrapperFunctionId,
        ID_PARAM: idParam,
        COMPONENT_PARAM: componentParam,
        EXPRESSION: expression
      })
    }
  }

  return {
    visitor: {
      Program (path, {file, opts}) {
        VduxTransformBuilder.assertValidOptions(opts)
        const builder = new VduxTransformBuilder(file, opts)
        builder.build()
      }
    }
  }
}
