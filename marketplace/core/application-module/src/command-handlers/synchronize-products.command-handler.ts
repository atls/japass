import { Logger }                     from '@atls/logger'
import { CommandHandler }             from '@nestjs/cqrs'
import { ICommandHandler }            from '@nestjs/cqrs'
import { EventBus }                   from '@nestjs/cqrs'

import pLimit                         from 'p-limit'
import { Observable }                 from 'rxjs'

import { Product }                    from '@marketplace/domain-module'
import { InjectMarketplaceService }   from '@marketplace/domain-module'
import { MarketplaceService }         from '@marketplace/domain-module'
import { InjectProductsRepository }   from '@marketplace/domain-module'
import { ProductsRepository }         from '@marketplace/domain-module'

import { SynchronizeProductsCommand } from '../commands'
import { SynchronizedProductsEvent }  from '../events'

@CommandHandler(SynchronizeProductsCommand)
export class SynchronizeProductsCommandHandler
  implements ICommandHandler<SynchronizeProductsCommand>
{
  #logger: Logger = new Logger(SynchronizeProductsCommandHandler.name)

  constructor(
    @InjectMarketplaceService()
    private readonly marketplaceService: MarketplaceService,
    @InjectProductsRepository()
    private readonly productsRepository: ProductsRepository,
    private readonly eventBus: EventBus
  ) {}

  async execute() {
    const productsObservable$: Observable<Array<Product>> = this.marketplaceService.getProducts()

    const commonLimit = pLimit(2)
    let completed = false

    productsObservable$.subscribe({
      next: (products) => {
        const execute = async () => {
          const limit = pLimit(2)

          const finalBatch: Array<Product> = []
          const createProductsBatch: Array<Product> = []
          const removeProductsBatch: Array<Product> = []

          const productsFromDb: Array<Product | undefined> = await Promise.all(
            products.map((product) =>
              limit(async () => {
                const productFromDb = await this.productsRepository.findByArticleNumber(
                  product.articleNumber
                )

                if (!productFromDb) {
                  product.update(product.price, 0)
                  removeProductsBatch.push(product)
                }

                return productFromDb
              }))
          )

          if (removeProductsBatch.length > 0) {
            this.#logger.info(`Removing ${removeProductsBatch.length} products`)
            await this.marketplaceService.updateStocks({ products: removeProductsBatch })
          }

          for (const product of productsFromDb) {
            if (product && product.remains > 10) {
              if (product.price < 150) {
                createProductsBatch.push(
                  new Product({
                    ...product.properties,
                    name: `${product.name} (${product.minForOrder()} шт.)`,
                    price: product.price * product.minForOrder(),
                  })
                )
              } else finalBatch.push(product)
            } else if (product) {
              product.update(product.price, 0)
              finalBatch.push(product)
            }
          }

          if (createProductsBatch.length > 0) {
            await this.marketplaceService.createProducts({ products: createProductsBatch })
            await this.marketplaceService.updateStocks({ products: createProductsBatch })
            await this.marketplaceService.updatePrices({ products: createProductsBatch })
          }

          if (finalBatch.length > 0) {
            await this.marketplaceService.updateStocks({ products: finalBatch })
            await this.marketplaceService.updatePrices({ products: finalBatch })
          }
        }

        commonLimit(execute).then(() => {
          this.#logger.info(`Operations left: ${commonLimit.pendingCount}`)
          if (completed && commonLimit.activeCount === 0) {
            this.#logger.info('No active operations')
            this.eventBus.publish(new SynchronizedProductsEvent())
          }
        })
      },
      complete: () => {
        this.#logger.info(`Fetched all products`)
        completed = true
      },
    })
  }
}
