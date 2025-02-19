/**
 * Module to deal with discovering available endpoints
 */
import axios, { AxiosInstance, AxiosResponse, AxiosRequestConfig, AxiosError } from 'axios';
import * as base64JS from 'base64-js';
import { AIMSSessionDescriptor, AIMSAccount } from './types/aims-stub.types';
import {
    AlLocatorService, AlLocation, AlLocationDescriptor, AlLocationContext,
    AlStopwatch, AlTriggerStream, AlCabinet, AlGlobalizer,
    AlAPIServerError, AlResponseValidationError
} from '@al/common';
import { AlRequestDescriptor } from './utility';
import { AlClientBeforeRequestEvent } from './events';

export type AlEndpointsServiceCollection = {[serviceName:string]:string};

/**
 * Describes a single request to be issued against an API.
 * Please notice that it extends the underlying AxiosRequestConfig interface,
 * whose properties are detailed in node_modules/axios/index.d.ts or at https://www.npmjs.com/package/axios#request-config.
 */
export interface APIRequestParams extends AxiosRequestConfig {
  /**
   * The following parameters are used to resolve the correct service location and request path.
   * The presence of `service_name` on a request triggers this process.
   */
  service_stack?:string;            //  Indicates which service stack the request should be issued to.  This should be one of the location identifiers in @al/common's AlLocation.
  service_name?: string;            //  Which service are we trying to talk to?
  residency?: string;               //  What residency domain do we prefer?  Defaults to 'default'.
  version?: string|number;          //  What version of the service do we want to talk to?
  account_id?: string;              //  Which account_id's data are we trying to access/modify through the service?
  path?: string;                    //  What is the path of the specific command within the resolved service that we are trying to interact with?
  noEndpointsResolution?:boolean;   //  If set and truthy, endpoints resolution will *not* be used before the request is issued.

  /**
   * Should data fetched from this endpoint be cached?  0 ignores caching, non-zero values are treated as milliseconds to persist retrieved data in local memory.
   */
  ttl?: number|boolean;

  /**
   * If automatic retry functionality is desired, specify the maximum number of retries and interval multiplier here.
   */
  retry_count?: number;             //  Maximum number of retries
  retry_interval?: number;          //  Delay between any two retries = attemptIndex * retryInterval, defaults to 1000ms

  /**
   * @deprecated If provided, populates Headers.Accept
   */
  accept_header?: string;

  /**
   * @deprecated If provided, is simply copied to axios' `responseType` property
   */
  response_type?: string;
}

export class AlApiClient
{
  /**
   * The following list of services are the ones whose endpoints will be resolved by default.  Added globally/commonly used services here for optimized API performance.
   */
  protected static defaultServiceList = [ "aims", "subscriptions", "search", "sources", "assets_query", "assets_write", "dashboards", "iris", "suggestions", "cargo" ];
  protected static defaultServiceParams = {
    service_stack:      AlLocation.InsightAPI,  //  May also be AlLocation.GlobalAPI, AlLocation.EndpointsAPI, or ALLocation.LegacyUI
    residency:          'default',              //  "us" or "emea" or "default"
    version:            'v1',                   //  Version of the service
    ttl:                false                   //  Default to no caching
  };

  public events:AlTriggerStream = new AlTriggerStream();
  public verbose:boolean = false;
  public defaultAccountId:string = null;        //  If specified, uses *this* account ID to resolve endpoints if no other account ID is explicitly specified

  private storage = AlCabinet.ephemeral( 'apiclient.cache' );
  private endpointResolution:{[accountId:string]:Promise<AlEndpointsServiceCollection>} = {};
  private instance:AxiosInstance = null;

  /* Default request parameters */
  private globalServiceParams: APIRequestParams = Object.assign( {}, AlApiClient.defaultServiceParams );

  constructor() {}

  /**
   * Resets internal state back to its factory defaults.
   */
  public reset():AlApiClient {
    this.endpointResolution = {};
    this.instance = null;
    this.storage.destroy();
    this.globalServiceParams = Object.assign( {}, AlApiClient.defaultServiceParams );
    return this;
  }

  /**
   * This allows the host to set global parameters that will be used for every request, either for Axios or the @al/client service layer.
   * Most notably, setting `noEndpointsResolution` to true will suppress endpoints resolution for all requests, and cause default endpoint values to be used.
   */
  public setGlobalParameters( parameters:APIRequestParams ):AlApiClient {
    this.globalServiceParams = Object.assign( this.globalServiceParams, parameters );
    return this;
  }

  /**
   * GET - Return Cache, or Call for updated data
   */
  public async get(config: APIRequestParams) {
    config.method = 'GET';
    let normalized = await this.normalizeRequest( config );
    let queryParams = '';
    if ( config.params ) {
      queryParams = Object.entries( config.params ).map( ( [ p, v ] ) => `${p}=${encodeURIComponent( typeof( v ) === 'string' ? v : v.toString() )}` ).join("&");     //  qs.stringify in 1 line
    }
    let fullUrl = `normalized.url${queryParams.length>0?'?'+queryParams:''}`;

    let cacheTTL = 0;
    if ( typeof( normalized.ttl ) === 'number' && normalized.ttl > 0 ) {
      cacheTTL = normalized.ttl;
    } else if ( typeof( normalized.ttl ) === 'boolean' && normalized.ttl ) {
      cacheTTL = 60000;
    }
    if ( cacheTTL ) {
      let cachedValue = this.getCachedValue( fullUrl );
      if ( cachedValue ) {
        this.log(`APIClient::XHR GET ${fullUrl} (FROM CACHE)` );
        return cachedValue;
      }
    }
    this.log(`APIClient::XHR GET ${fullUrl}` );
    const response = await this.axiosRequest( normalized );
    if ( cacheTTL ) {
      this.log(`APIClient::cache(${fullUrl} for ${cacheTTL}ms`);
      this.setCachedValue( fullUrl, response.data, cacheTTL );
    }
    return response.data;
  }

  /**
   * @deprecated
   * Alias for GET utility method
   */
  public async fetch(config: APIRequestParams) {
    console.warn("Deprecation warning: do not use AlApiClient.fetch; use `get` instead." );
    return this.get( config );
  }

  /**
   * POST - clears cache and posts for new/merged data
   */
  public async post(config: APIRequestParams) {
    config.method = 'POST';
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    this.log(`APIClient::XHR POST ${normalized.url}` );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * Form data submission
   */
  public async form(config: APIRequestParams) {
    config.method = 'POST';
    config.headers = {
        'Content-Type': 'multipart/form-data'
    };
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * PUT - replaces data
   */
  public async put(config: APIRequestParams) {
    config.method = 'PUT';
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    this.log(`APIClient::XHR PUT ${normalized.url}` );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * @deprecated
   * Alias for PUT utility method
   */
  public async set( config:APIRequestParams ) {
    console.warn("Deprecation warning: do not use AlApiClient.set; use `put` instead." );
    return this.put( config );
  }

  /**
   * Delete data
   */
  public async delete(config: APIRequestParams) {
    config.method = 'DELETE';
    const normalized = await this.normalizeRequest( config );
    this.deleteCachedValue( normalized.url );
    this.log(`APIClient::XHR DELETE ${normalized.url}` );
    const response = await this.axiosRequest( normalized );
    return response.data;
  }

  /**
   * Create a request descriptor interface
   */
  public request<ResponseType>( method:string ):AlRequestDescriptor<ResponseType> {
    const descriptor = new AlRequestDescriptor<ResponseType>( this.executeRequest, method );
    return descriptor;
  }

  public async executeRequest<ResponseType>( options:APIRequestParams ):Promise<AxiosResponse<ResponseType>> {
    return this.axiosRequest( options );
  }

  /**
   * @deprecated
   *
   * Provides a concise way to manipulate the AlLocatorService without importing it directly...
   *
   * @param {array} locations An array of locator descriptors.
   * @param {string|boolean} actingUri The URI to use to calculate the current location and location context; defaults to window.location.origin.
   * @param {AlLocationContext} The effective location context.  See @al/common for more information.
   */
  /* istanbul ignore next */
  public setLocations( locations:AlLocationDescriptor[], actingUri:string|boolean = true, context:AlLocationContext = null ) {
      throw new Error("Please use AlLocatorService.setLocations to update location metadata." );
  }

  /**
   * @deprecated
   *
   * Provides a concise way to set location context without importing AlLocatorService directly.
   *
   * @param {string} environment Should be 'production', 'integration', or 'development'
   * @param {string} residency Should be 'US' or 'EMEA'
   * @param {string} locationId If provided, should be one of the locations service location codes, e.g., defender-us-denver
   * @param {string} accessibleLocations If provided, should be a list of accessible locations service location codes.
   */
  /* istanbul ignore next */
  public setLocationContext( environment:string, residency?:string, locationId?:string, accessibleLocations?:string[] ) {
      throw new Error("Please use AlLocatorService.setContext to override location context." );
  }

  /**
   * @deprecated
   */
  /* istanbul ignore next */
  public resolveLocation( locTypeId:string, path:string = null, context:AlLocationContext = null ) {
    console.warn("Deprecation notice: please use AlLocatorService.resolveURL to calculate resource locations." );
    return AlLocatorService.resolveURL( locTypeId, path, context );
  }

  /**
   * Use HTTP Basic Auth
   * Optionally supply an mfa code if the user account is enrolled for Multi-Factor Authentication
   *
   * Under ordinary circumstances, you should *not* be calling this directly -- instead, you should use the top-level
   * `authenticate` method on @al/session's ALSession instance.
   */
  async authenticate( user: string, pass: string, mfa?:string, ignoreWarning?:boolean ):Promise<AIMSSessionDescriptor> {
    if ( ! ignoreWarning ) {
      console.warn("Warning: this low level authentication method is intended only for use by other services, and will not create a reusable session.  Are you sure you intended to use it?" );
    }
    let payload = {};
    if (mfa) {
      payload = { mfa_code: mfa };
    }
    return this.post( {
      service_stack: AlLocation.GlobalAPI,
      service_name: 'aims',
      path: 'authenticate',
      headers: {
        Authorization: `Basic ${this.base64Encode(`${user}:${pass}`)}`
      },
      data: payload
    });
  }

  /**
   * Authenticate with an mfa code and a temporary session token.
   * Used when a user inputs correct username:password but does not include mfa code when they are enrolled for Multi-Factor Authentication
   * The session token can be used to complete authentication without re-entering the username and password, but must be used within 3 minutes (token expires)
   *
   * Under ordinary circumstances, you should *not* be calling this directly -- instead, you should use the top-level
   * `authenticateWithMFASessionToken` method on @al/session's ALSession instance.
   */
  /* tslint:disable:variable-name */
  async authenticateWithMFASessionToken(token: string, mfa_code: string, ignoreWarning?:boolean):Promise<AIMSSessionDescriptor> {
    if ( ! ignoreWarning ) {
      console.warn("Warning: this low level authentication method is intended only for use by other services, and will not create a reusable session.  Are you sure you intended to use it?" );
    }
    return this.post( {
      service_stack: AlLocation.GlobalAPI,
      service_name: 'aims',
      path: 'authenticate',
      headers: {
        'X-AIMS-Session-Token': token
      },
      data: {
        mfa_code: mfa_code
      }
    } );
  }

  /**
   * Converts a string input to its base64 encoded equivalent.  Uses browser-provided btoa if available, or 3rd party btoa module as a fallback.
   */
  public base64Encode( data:string ):string {
    if ( this.isBrowserBased() && window.btoa ) {
        return btoa( data );
    }
    let utf8Data = unescape( encodeURIComponent( data ) );        //  forces conversion to utf8 from utf16, because...  not sure why
    let bytes = [];
    for ( let i = 0; i < utf8Data.length; i++ ) {
      bytes.push( utf8Data.charCodeAt( i ) );
    }
    let result = base64JS.fromByteArray( bytes );
    return result;
  }

  public async normalizeRequest(config: APIRequestParams):Promise<APIRequestParams> {
    if ( config.hasOwnProperty("service_name" ) || config.hasOwnProperty("service_stack") ) {
      // If we are using endpoints resolution to determine our calculated URL, merge globalServiceParams into our configuration
      config = Object.assign( {}, this.globalServiceParams, config );       //  clever
      config.url = await this.calculateRequestURL( config );
    } else {
      console.warn("Warning: not assign URL to request!", config );
    }
    if (config.accept_header) {
      console.warn("Deprecation warning: please do not use accept_header shortcut mechanism." );
      if ( ! config.headers ) {
        config.headers = {};
      }
      config.headers.Accept = config.accept_header;
      delete config.accept_header;
    }
    if (config.response_type) {
      config.responseType = config.response_type;
      delete config.response_type;
    }
    return config;
  }

  protected async calculateRequestURL( params: APIRequestParams ):Promise<string> {
    let fullPath = '';
    if ( params.service_name && params.service_stack === AlLocation.InsightAPI && ! params.noEndpointsResolution ) {
      // Utilize the endpoints service to determine which location to use for this service/account pair
      const serviceCollection = await this.prepare( params );
      fullPath = serviceCollection[params.service_name];
    } else {
      // Otherwise, just use the built-in defaults
      fullPath = AlLocatorService.resolveURL( params.service_stack );
    }
    if ( params.service_name ) {
        fullPath += `/${params.service_name}`;
    }
    if ( params.version ) {
      if ( typeof( params.version ) === 'string' && params.version.length > 0 ) {
        fullPath += `/${params.version}`;
      } else if ( typeof( params.version ) === 'number' && params.version > 0 ) {
        fullPath += `/v${params.version.toString()}`;
      }
    }
    if (params.account_id && params.account_id !== '0') {
      fullPath += `/${params.account_id}`;
    }
    if (params.hasOwnProperty('path') && params.path.length > 0 ) {
      fullPath += ( params.path[0] === '/' ? '' : '/' )  + params.path;
    }
    return fullPath;
  }

  /**
   * This method (and its partner, getServiceEndpoints) uses running promise sequences to retrieve endpoints (using the multiple endpoint lookup action)
   * in such a way that
   *    a) most basic services will be retrieved in a single call
   *    b) the initial call is guaranteed to included the service a request is being formed for
   *    c) only one outstanding call to the endpoints service will be issued, per account, at a given time
   */
  protected async prepare( requestParams:APIRequestParams ):Promise<AlEndpointsServiceCollection> {
    const accountId = requestParams.account_id || this.defaultAccountId || "0";
    if ( ! this.endpointResolution.hasOwnProperty( accountId ) ) {
      let serviceList = AlApiClient.defaultServiceList;
      if ( ! serviceList.includes( requestParams.service_name ) ) {
        serviceList.push( requestParams.service_name );
      }
      this.endpointResolution[accountId] = this.getServiceEndpoints( accountId, serviceList );
    }
    let collection = await this.endpointResolution[accountId];
    if ( collection.hasOwnProperty( requestParams.service_name ) ) {
      return collection;
    }
    this.deleteCachedValue( `/endpoints/${accountId}` );    //  If we reach this point, we don't already have endpoints data for the service being requested -- so, jettison any cached data and ask again.
    this.endpointResolution[accountId] = this.getServiceEndpoints( accountId, Object.keys( collection ).concat( requestParams.service_name ) );
    return this.endpointResolution[accountId];
  }

  protected async getServiceEndpoints( accountId:string, serviceList:string[] ):Promise<AlEndpointsServiceCollection> {
    const cacheKey = `/endpoints/${accountId}`;
    let cached = this.getCachedValue<AlEndpointsServiceCollection>( cacheKey );
    if ( cached ) {
        return cached;
    }
    const endpointsRequest = {
      method: "POST",
      url: AlLocatorService.resolveURL( AlLocation.GlobalAPI, `/endpoints/v1/${accountId}/residency/default/endpoints` ),
      data: serviceList
    };
    return this.axiosRequest( endpointsRequest )
              .then( response => {
                  let translated = {};
                  Object.entries( response.data ).forEach( ( [ serviceName, endpointHost ] ) => {
                    translated[serviceName] = ( endpointHost as string ).startsWith( "http") ? endpointHost : `https://${endpointHost}`;        // ensure that all domains are prefixed with protocol
                  } );
                  this.setCachedValue( cacheKey, translated, 15 * 60 * 1000 );
                  return translated as AlEndpointsServiceCollection;
              }, error => {
                console.warn("Could not get endpoints response!  Using defaults." );
                let serviceLocations:{[serviceId:string]:string} = {};
                serviceList.forEach( serviceId => { serviceLocations[serviceId] = AlLocatorService.resolveURL( AlLocation.InsightAPI ); } );
                this.setCachedValue( cacheKey, serviceList, 5 * 60 * 1000 );
                return Promise.resolve( serviceLocations );
              } );
  }

  /**
   * Instantiate a properly configured axios client for services
   */
  protected getAxiosInstance(): AxiosInstance {
    if ( this.instance ) {
      return this.instance;
    }

    let headers = {
      'Accept': 'application/json, text/plain, */*'
    };

    this.instance = axios.create({
      timeout: 10000,
      withCredentials: true,
      headers: headers
    });

    this.instance.interceptors.request.use(
      config => {
        this.events.trigger( new AlClientBeforeRequestEvent( config ) );        //    Allow event subscribers to modify the request (e.g., add a session token header) if they want
        config.validateStatus = ( responseStatus:number ) => {
            //  This forces all responses to run through our response interceptor
            return true;
        };
        return config;
      }
    );
    this.instance.interceptors.response.use( response => this.onRequestResponse( response ) );
    return this.instance;
  }

  protected onRequestResponse = ( response:AxiosResponse ):Promise<AxiosResponse> => {
    if ( response.status < 200 || response.status >= 400 ) {
      return this.onRequestError( response );
    }
    return Promise.resolve( response );
  }

  protected onRequestError = ( errorResponse:AxiosResponse ):Promise<any> => {
    if ( errorResponse.status >= 500 ) {
        //  TODO: dispatch service error event
        console.error(`APIClient Warning: received response ${errorResponse.status} from API request [${errorResponse.config.method} ${errorResponse.config.url}]`);
    } else if ( errorResponse.status >= 400 ) {
        //  TODO: dispatch client request error event
        console.error(`APIClient Warning: received response ${errorResponse.status} from API request [${errorResponse.config.method} ${errorResponse.config.url}]`);
    } else if ( errorResponse.status < 200 ) {
        //  TODO: not quite sure...
        console.error(`APIClient Warning: received ${errorResponse.status} from API request [${errorResponse.config.method} ${errorResponse.config.url}]`);
    }
    return Promise.reject( errorResponse );
  }

  /**
   * Inner request method.  If automatic retry is enabled via the retry_count property of the request config, this method
   * will catch errors of status code 0/3XX/5XX and retry them at staggered intervals (by default, a factorial delay based on number of retries).
   * If any of these requests succeed, the outer promise will be satisfied using the successful result.
   */
  protected async axiosRequest<ResponseType = any>( config:APIRequestParams, attemptIndex:number = 0 ):Promise<AxiosResponse<ResponseType>> {
    const ax = this.getAxiosInstance();
    return ax( config ).then( response => {
                                if ( attemptIndex > 0 ) {
                                  console.warn(`Notice: resolved request for ${config.url} with retry logic.` );
                                }
                                return response;
                              },
                              error => {
                                if ( this.isRetryableError( error, config, attemptIndex ) ) {
                                  attemptIndex++;
                                  const delay = Math.floor( ( config.retry_interval ? config.retry_interval : 1000 ) * attemptIndex );
                                  return new Promise<AxiosResponse>( ( resolve, reject ) => {
                                    AlStopwatch.once(   () => {
                                                          config.params = config.params || {};
                                                          config.params.breaker = this.generateCacheBuster( attemptIndex );
                                                          this.axiosRequest( config, attemptIndex + 1 ).then( resolve, reject );
                                                        },
                                                        delay );
                                  } );
                                }
                                return Promise.reject( error );
                              } );
  }

  /**
   * Utility method to determine whether a given response is a retryable error.
   */
  protected isRetryableError( error:AxiosResponse, config:APIRequestParams, attemptIndex:number ) {
    if ( ! config.hasOwnProperty("retry_count" ) || attemptIndex >= config.retry_count ) {
      return false;
    }
    if ( ! error ) {
      console.warn( `Notice: will retry request for ${config.url} (null response condition)` );
      return true;
    }
    if ( error.status === 0
          || ( error.status >= 300 && error.status <= 399 )
          || ( error.status >= 500 && error.status <= 599 ) ) {
      console.warn( `Notice: will retry request for ${config.url} (${error.status} response code)` );
      return true;
    }
    return false;
  }

  /**
   * Generates a random cache-busting parameter
   */
  protected generateCacheBuster( attemptIndex:number ) {
    const verbs = ['debork', 'breaker', 'breaker-breaker', 'fix', 'unbork', 'corex', 'help'];
    const verb = verbs[Math.floor( Math.random() * verbs.length )];
    const hash = ( Date.now() % 60000 ).toString() + Math.floor( Math.random() * 100000 ).toString();
    return `${verb}-${hash}-${attemptIndex.toString()}`;
  }

  /**
   *
   */
  private getCachedValue<ResponseType = any>( key:string):ResponseType {
    return this.storage.get( key ) as ResponseType;
  }

  private setCachedValue( key:string, data:any, ttl:number ):void {
    if ( ttl < 1000 ) {
      return;
    }
    this.storage.set( key, data, Math.floor( ttl / 1000 ) );
  }

  private deleteCachedValue( key:string ):void {
    this.storage.delete( key );
  }

  /**
   * Are we running in a browser?
   */
  private isBrowserBased() {
    if (typeof window === 'undefined') {
      return false;
    }
    return true;
  }

  private log( text:string, ...otherArgs:any[] ) {
      if ( this.verbose ) {
          console.log.apply( console, arguments );
      }
  }
}

/* tslint:disable:variable-name */
export const AlDefaultClient = AlGlobalizer.instantiate( 'ALClient', () => new AlApiClient() );
